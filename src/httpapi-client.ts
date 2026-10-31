import type * as HttpClientError from "effect/http/HttpClientError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpApiClient, type HttpApiError } from "effect/http-api";
import { Context, Effect, Layer, Match, Option, type Schema } from "effect";
import * as S from "effect/Schema";
import { PgGardenApi } from "../server/apiSchema";
import {
  ApiError,
  Conflict,
  Forbidden,
  Locked,
  NotFound,
  ServerError,
  Unauthorized,
} from "../server/errors";
import { makeRequestTelemetry, type RequestTelemetry, telemetryHeaders } from "./requestTelemetry";

/** Everything a call through the generated client can fail with. */
type ClientFailure =
  | ApiError
  | Conflict
  | Forbidden
  | HttpApiError.HttpApiSchemaError
  | HttpClientError.HttpClientError
  | Locked
  | NotFound
  | Schema.SchemaError
  | ServerError
  | Unauthorized;

/**
 * One failed server call, in the shape the UI needs: a status to branch on and
 * a message to show. `status` is 0 when the request never reached the server.
 */
export class ApiRequestError extends S.TaggedError<
  ApiRequestError,
  { readonly brand: unique symbol }
>()("ApiRequestError", {
  status: S.Int,
  message: S.String,
}) {}

const toApiRequestError = Match.type<ClientFailure>().pipe(
  Match.tag("ApiError", (error) => new ApiRequestError({ status: 400, message: error.error })),
  Match.tag("Unauthorized", (error) => new ApiRequestError({ status: 401, message: error.error })),
  Match.tag("Forbidden", (error) => new ApiRequestError({ status: 403, message: error.error })),
  Match.tag("NotFound", (error) => new ApiRequestError({ status: 404, message: error.error })),
  Match.tag("Conflict", (error) => new ApiRequestError({ status: 409, message: error.error })),
  Match.tag("Locked", (error) => new ApiRequestError({ status: 423, message: error.error })),
  Match.tag("ServerError", (error) => new ApiRequestError({ status: 500, message: error.error })),
  Match.tag(
    "HttpClientError",
    (error) => new ApiRequestError({ status: 0, message: error.message }),
  ),
  // The server answered with something the contract does not describe, so the
  // two sides disagree. Nothing the visitor did can fix it.
  Match.tag(
    "HttpApiSchemaError",
    (error) =>
      new ApiRequestError({
        status: 500,
        message: `The server's ${error.kind.toLowerCase()} did not match the contract: ${error.cause.message}`,
      }),
  ),
  Match.tag("SchemaError", (error) => new ApiRequestError({ status: 500, message: error.message })),
  Match.exhaustive,
);

/**
 * Observability context for the call in flight. Whoever starts a call provides
 * it; the client turns it into request headers the server reads back. None
 * means there is no UI action to attribute the call to.
 */
export const CurrentRequestTelemetry = Context.Reference<Option.Option<RequestTelemetry>>(
  "postgres-garden/CurrentRequestTelemetry",
  { defaultValue: Option.none },
);

const withTelemetryHeaders = (httpClient: HttpClient.HttpClient) =>
  HttpClient.mapRequestEffect(httpClient, (request) =>
    Effect.map(
      CurrentRequestTelemetry,
      Option.match({
        onNone: () => request,
        onSome: (telemetry) => HttpClientRequest.setHeaders(request, telemetryHeaders(telemetry)),
      }),
    ),
  );

/**
 * Builds the typed client for `PgGardenApi` over one transport.
 *
 * The workbench talks to the server with `fetch`; a sandboxed webview cannot,
 * so it passes a transport that relays each request through the extension host
 * (`features/webview/relayTransport.ts`). Both sides get the same client, so
 * both decode the server's answer with the contract instead of trusting a
 * shape they wrote by hand.
 */
export const makePgGardenClient = (options: {
  readonly baseUrl: string;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
}) =>
  HttpApiClient.make(PgGardenApi, {
    baseUrl: options.baseUrl,
    transformClient: withTelemetryHeaders,
  }).pipe(Effect.provide(options.transport));

export type PgGardenClient = Effect.Success<ReturnType<typeof makePgGardenClient>>;

/**
 * Makes `run`'s call as one named UI action: attributes it for tracing and
 * flattens every way the call can fail into `ApiRequestError`.
 */
export const makeApiCaller =
  (options: { readonly client: Effect.Effect<PgGardenClient>; readonly feature: string }) =>
  <A, E extends ClientFailure>(
    action: string,
    run: (api: PgGardenClient) => Effect.Effect<A, E>,
  ): Effect.Effect<A, ApiRequestError> =>
    Effect.gen(function* () {
      const telemetry = yield* makeRequestTelemetry({ action, feature: options.feature });
      const api = yield* options.client;
      return yield* run(api).pipe(
        Effect.provideService(CurrentRequestTelemetry, Option.some(telemetry)),
      );
    }).pipe(Effect.withSpan(`api ${action}`), Effect.mapError(toApiRequestError));

// Suspended so that importing this module reads no browser global: the
// workbench's own origin is needed only when a call is actually made.
const client = Effect.suspend(() =>
  makePgGardenClient({
    baseUrl: window.location.origin,
    transport: Layer.mergeAll(
      FetchHttpClient.layer,
      // The workbench is served from this origin, so the session cookie
      // travels with every call.
      Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
    ),
  }),
);

const call = makeApiCaller({ client, feature: "workbench" });

// --- Session ---------------------------------------------------------------

export const httpApiMe = call("me", (api) => api.apiUsers.me({}));

export const httpApiLogout = call("logout", (api) => api.auth.logout({}));

// --- Playgrounds -----------------------------------------------------------

export const httpApiGetPlayground = (hash: string) =>
  call("playgrounds.get", (api) => api.apiPlaygrounds.playgroundByHash({ params: { hash } }));

export const httpApiCreatePlayground = (payload: {
  readonly name?: string | null;
  readonly message: string;
  readonly description?: string | null;
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly activeFile?: string | null;
}) => call("playgrounds.create", (api) => api.apiPlaygrounds.createPlayground({ payload }));

export const httpApiTogglePlaygroundStar = (hash: string) =>
  call("playgrounds.star", (api) => api.apiPlaygrounds.togglePlaygroundStar({ params: { hash } }));

// --- Commits ---------------------------------------------------------------

export const httpApiCreatePlaygroundCommit = (
  hash: string,
  payload: {
    readonly message: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    readonly activeFile?: string | null;
  },
) =>
  call("commits.create", (api) => api.apiPlaygrounds.createCommit({ params: { hash }, payload }));

export const httpApiListPlaygroundCommits = (hash: string) =>
  call("commits.list", (api) => api.apiPlaygrounds.listCommits({ params: { hash } }));

export const httpApiGetPlaygroundCommit = (hash: string, commit_id: string) =>
  call("commits.get", (api) => api.apiPlaygrounds.getCommit({ params: { hash, commit_id } }));

export const httpApiGetPlaygroundCommitDiff = (hash: string, commit_id: string) =>
  call("commits.diff", (api) => api.apiPlaygrounds.getCommitDiff({ params: { hash, commit_id } }));
