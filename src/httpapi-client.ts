import type * as HttpClientError from "effect/http/HttpClientError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpApiClient, type HttpApiError } from "effect/http-api";
import { Context, Effect, Layer, Match, Option, type Schema } from "effect";
import * as S from "effect/Schema";
import { PgGardenApi } from "../shared/httpApi";
import { editKeyHeaders } from "./shared/editKey";
import {
  Conflict,
  Forbidden,
  InternalError,
  InvalidOperation,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
} from "../shared/errors";
import { makeRequestTelemetry, type RequestTelemetry, telemetryHeaders } from "./requestTelemetry";

/** The generated client for `PgGardenApi`. */
export type PgGardenClient = HttpApiClient.ForApi<typeof PgGardenApi>;

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
  }) =>
    Layer.effect(
      ApiCaller,
      Effect.gen(function* () {
        // Built once per layer, not once per call.
        const client = yield* HttpApiClient.make(PgGardenApi, {
          baseUrl: options.baseUrl,
          transformClient: (httpClient) =>
            HttpClient.mapRequestEffect(httpClient, (request) =>
              Effect.map(
                CurrentRequestTelemetry,
                Option.match({
                  onNone: () => request,
                  onSome: (telemetry) =>
                    HttpClientRequest.setHeaders(request, telemetryHeaders(telemetry)),
                }),
              ),
            ),
        }).pipe(Effect.provide(options.transport));

        const call: ApiCaller["Service"]["call"] = (action, run) =>
          Effect.gen(function* () {
            const telemetry = yield* makeRequestTelemetry({ action, feature: options.feature });
            return yield* run(client).pipe(
              Effect.provideService(CurrentRequestTelemetry, Option.some(telemetry)),
            );
          }).pipe(Effect.withSpan(`api ${action}`), Effect.mapError(toApiRequestError));

        return { call };
      }),
    );

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

/** Everything a call through the generated client can fail with. */
export type ClientFailure =
  | Conflict
  | Forbidden
  | HttpApiError.HttpApiSchemaError
  | HttpClientError.HttpClientError
  | InternalError
  | InvalidOperation
  | Locked
  | NotFound
  | Schema.SchemaError
  | ServiceUnavailable
  | TooManyRequests
  | Unauthorized;

/**
 * Observability context for the call in flight. `ApiCaller` provides it around
 * each call; the client turns it into request headers the server reads back.
 * The generated client takes no per-call headers, so this is the only channel.
 * None means there is no UI action to attribute the call to.
 */
const CurrentRequestTelemetry = Context.Reference<Option.Option<RequestTelemetry>>(
  "postgres-garden/CurrentRequestTelemetry",
  { defaultValue: Option.none },
);

const toApiRequestError = Match.type<ClientFailure>().pipe(
  Match.tag(
    "InvalidOperation",
    (error) => new ApiRequestError({ status: 400, message: error.message }),
  ),
  Match.tag(
    "Unauthorized",
    (error) => new ApiRequestError({ status: 401, message: error.message }),
  ),
  Match.tag("Forbidden", (error) => new ApiRequestError({ status: 403, message: error.message })),
  Match.tag("NotFound", (error) => new ApiRequestError({ status: 404, message: error.message })),
  Match.tag("Conflict", (error) => new ApiRequestError({ status: 409, message: error.message })),
  Match.tag("Locked", (error) => new ApiRequestError({ status: 423, message: error.message })),
  Match.tag(
    "TooManyRequests",
    (error) => new ApiRequestError({ status: 429, message: error.message }),
  ),
  Match.tag(
    "ServiceUnavailable",
    (error) => new ApiRequestError({ status: 503, message: error.message }),
  ),
  // The trace id is how a user report finds the logged cause, so the user sees it.
  Match.tag(
    "InternalError",
    (error) =>
      new ApiRequestError({
        status: 500,
        message: `${error.message} Reference: ${error.traceId}`,
      }),
  ),
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
