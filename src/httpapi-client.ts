import type * as HttpClientError from "effect/http/HttpClientError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpApiClient, type HttpApiError } from "effect/http-api";
import { Context, Effect, Layer, Match, Option, type Schema } from "effect";
import * as S from "effect/Schema";
import { PgGardenApi } from "../server/apiSchema";
import { editKeyHeaders } from "./shared/editKey";
import { ApiError, Conflict, Locked, NotFound, ServerError, Unauthorized } from "../server/errors";
import { makeRequestTelemetry, type RequestTelemetry, telemetryHeaders } from "./requestTelemetry";

/**
 * Makes calls against `PgGardenApi` as named UI actions: attributes each for
 * tracing and flattens every way it can fail into `ApiRequestError`.
 *
 * The workbench provides `ApiCaller.workbench`. A sandboxed webview cannot use
 * `fetch`, so it provides `ApiCaller.layer` over a transport that relays each
 * request through the extension host (`features/webview/relayTransport.ts`).
 * Both sides get the same client, so both decode the server's answer with the
 * contract instead of trusting a shape they wrote by hand.
 */
export class ApiCaller extends Context.Service<
  ApiCaller,
  {
    readonly call: <A, E extends ClientFailure>(
      action: string,
      run: (api: PgGardenClient) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, ApiRequestError>;
  }
>()("app/ApiCaller") {
  /** Calls over `options.transport`, attributed to `options.feature`. */
  static readonly layer = (options: {
    readonly baseUrl: string;
    readonly transport: Layer.Layer<HttpClient.HttpClient>;
    readonly feature: string;
  }) => Layer.effect(ApiCaller, makeApiCaller(options));

  /** Calls over `fetch` from the workbench page. */
  static readonly workbench = Layer.suspend(() =>
    ApiCaller.layer({
      // Read when the layer is built, not when this module loads: importing it
      // reads no browser global.
      baseUrl: window.location.origin,
      feature: "workbench",
      transport: Layer.mergeAll(
        withPageEditKey.pipe(Layer.provide(FetchHttpClient.layer)),
        // The workbench is served from this origin, so the session cookie
        // travels with every call.
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
      ),
    }),
  );
}

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

/** Makes `run`'s call through the `ApiCaller` in scope. */
export const apiCall = <A, E extends ClientFailure>(
  action: string,
  run: (api: PgGardenClient) => Effect.Effect<A, E>,
): Effect.Effect<A, ApiRequestError, ApiCaller> =>
  ApiCaller.use((caller) => caller.call(action, run));

/**
 * Observability context for the call in flight. `ApiCaller` provides it around
 * each call; the client turns it into request headers the server reads back.
 * None means there is no UI action to attribute the call to.
 */
export const CurrentRequestTelemetry = Context.Reference<Option.Option<RequestTelemetry>>(
  "postgres-garden/CurrentRequestTelemetry",
  { defaultValue: Option.none },
);

/** Builds the typed client for `PgGardenApi` over one transport. */
export const makePgGardenClient = (options: {
  readonly baseUrl: string;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
}) =>
  HttpApiClient.make(PgGardenApi, {
    baseUrl: options.baseUrl,
    transformClient: withTelemetryHeaders,
  }).pipe(Effect.provide(options.transport));

export type PgGardenClient = Effect.Success<ReturnType<typeof makePgGardenClient>>;

// --- Session ---------------------------------------------------------------

export const httpApiMe = apiCall("me", (api) => api.apiUsers.me({}));

export const httpApiLogout = apiCall("logout", (api) => api.auth.logout({}));

// --- Playgrounds -----------------------------------------------------------

export const httpApiGetPlayground = (hash: string) =>
  apiCall("playgrounds.get", (api) => api.apiPlaygrounds.playgroundByHash({ params: { hash } }));

/**
 * What the create endpoint accepts, taken from the contract rather than written
 * out again here. A field added to the endpoint reaches this caller's type with
 * no edit, which is how `privacy` was found missing: the hand-written copy this
 * replaces had no such field, so the client could not ask for one.
 */
type CreatePlaygroundPayload = Parameters<
  PgGardenClient["apiPlaygrounds"]["createPlayground"]
>[0]["payload"];

export const httpApiCreatePlayground = (payload: CreatePlaygroundPayload) =>
  apiCall("playgrounds.create", (api) => api.apiPlaygrounds.createPlayground({ payload }));

// The key this redeems rides on the request, like every other write that one
// holds: see shared/editKey.
export const httpApiClaimPlayground = (hash: string) =>
  apiCall("playgrounds.claim", (api) => api.apiPlaygrounds.claimPlayground({ params: { hash } }));

export const httpApiTogglePlaygroundStar = (hash: string) =>
  apiCall("playgrounds.star", (api) =>
    api.apiPlaygrounds.togglePlaygroundStar({ params: { hash } }),
  );

// --- Commits ---------------------------------------------------------------

/** Taken from the contract for the same reason as CreatePlaygroundPayload. */
type CreateCommitPayload = Parameters<
  PgGardenClient["apiPlaygrounds"]["createCommit"]
>[0]["payload"];

export const httpApiCreatePlaygroundCommit = (hash: string, payload: CreateCommitPayload) =>
  apiCall("commits.create", (api) =>
    api.apiPlaygrounds.createCommit({ params: { hash }, payload }),
  );

export const httpApiListPlaygroundCommits = (hash: string) =>
  apiCall("commits.list", (api) => api.apiPlaygrounds.listCommits({ params: { hash } }));

export const httpApiGetPlaygroundCommit = (hash: string, commit_id: string) =>
  apiCall("commits.get", (api) => api.apiPlaygrounds.getCommit({ params: { hash, commit_id } }));

export const httpApiGetPlaygroundCommitDiff = (hash: string, commit_id: string) =>
  apiCall("commits.diff", (api) =>
    api.apiPlaygrounds.getCommitDiff({ params: { hash, commit_id } }),
  );

// --- Internals -------------------------------------------------------------

/** Everything a call through the generated client can fail with. */
export type ClientFailure =
  | ApiError
  | Conflict
  | HttpApiError.HttpApiSchemaError
  | HttpClientError.HttpClientError
  | Locked
  | NotFound
  | Schema.SchemaError
  | ServerError
  | Unauthorized;

const makeApiCaller = (options: {
  readonly baseUrl: string;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
  readonly feature: string;
}) =>
  Effect.gen(function* () {
    // Built once per layer, not once per call.
    const api = yield* makePgGardenClient(options);
    const call: ApiCaller["Service"]["call"] = (action, run) =>
      Effect.gen(function* () {
        const telemetry = yield* makeRequestTelemetry({ action, feature: options.feature });
        return yield* run(api).pipe(
          Effect.provideService(CurrentRequestTelemetry, Option.some(telemetry)),
        );
      }).pipe(Effect.withSpan(`api ${action}`), Effect.mapError(toApiRequestError));
    return { call };
  });

const toApiRequestError = Match.type<ClientFailure>().pipe(
  Match.tag("ApiError", (error) => new ApiRequestError({ status: 400, message: error.error })),
  Match.tag("Unauthorized", (error) => new ApiRequestError({ status: 401, message: error.error })),
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
 * Carries the edit key for the playground the page has open, the way the
 * session cookie carries an account. A page holding no key sends none.
 *
 * Only the page does this. A webview cannot read the page's storage, so its
 * relayed requests are given the key by the extension host instead
 * (`features/webview/hostBridge.ts`).
 */
const withPageEditKey = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (httpClient) =>
    HttpClient.mapRequest(httpClient, (request) =>
      HttpClientRequest.setHeaders(request, editKeyHeaders()),
    ),
  ),
);
