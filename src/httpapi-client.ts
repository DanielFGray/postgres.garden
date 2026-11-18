import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpApiClient } from "effect/http-api";
import { Context, Effect, Layer, Option } from "effect";
import { PgGardenApi } from "../shared/httpApi";
import { editKeyHeaders } from "./shared/editKey";
import { type RequestTelemetry, telemetryHeaders } from "./requestTelemetry";

/** The generated client for `PgGardenApi`. */
export type PgGardenClient = HttpApiClient.ForApi<typeof PgGardenApi>;

type ApiCallerService = {
  readonly call: <A, E>(
    action: string,
    run: (api: PgGardenClient) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
};

const buildApiCaller = Effect.fnUntraced(function* (options: {
  readonly baseUrl: string;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
  readonly feature: string;
}) {
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
  const call: ApiCallerService["call"] = (action, run) =>
    run(client).pipe(
      Effect.provideService(
        CurrentRequestTelemetry,
        Option.some({ action, feature: options.feature }),
      ),
      Effect.withSpan(`api ${action}`),
    );
  return { call } satisfies ApiCallerService;
});

/**
 * Makes calls against `PgGardenApi` as named UI actions: attributes each for
 * tracing. A failed call fails with the error the contract declares for it, so
 * the UI shows its text with `errorMessage` and matches its `_tag` to treat
 * one refusal differently.
 *
 * The workbench provides `ApiCaller.layer`. A sandboxed webview cannot use
 * `fetch`, so it provides `ApiCaller.layerWebview` over a transport that relays each
 * request through the extension host (`features/webview/relayTransport.ts`).
 * Both sides get the same client, so both decode the server's answer with the
 * contract instead of trusting a shape they wrote by hand.
 */
export class ApiCaller extends Context.Service<ApiCaller, ApiCallerService>()(
  "postgres-garden/httpapi-client/ApiCaller",
  {
    make: Effect.suspend(() =>
      buildApiCaller({
        baseUrl: window.location.origin,
        feature: "workbench",
        transport: Layer.mergeAll(
          withPageEditKey.pipe(Layer.provide(FetchHttpClient.layer)),
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
        ),
      }),
    ),
  },
) {
  /** Calls over `fetch` from the workbench page. */
  static readonly layer = Layer.effect(this, this.make);

  /** Calls over `options.transport`, attributed to `options.feature`. */
  static readonly layerWebview = (options: {
    readonly baseUrl: string;
    readonly transport: Layer.Layer<HttpClient.HttpClient>;
    readonly feature: string;
  }) => Layer.effect(ApiCaller, buildApiCaller(options));
}

/**
 * Observability context for the call in flight. `ApiCaller` provides it around
 * each call; the client turns it into request headers.
 * The generated client takes no per-call headers, so this is the only channel.
 * None means there is no UI action to attribute the call to.
 */
const CurrentRequestTelemetry = Context.Reference<Option.Option<RequestTelemetry>>(
  "postgres-garden/CurrentRequestTelemetry",
  { defaultValue: Option.none },
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
