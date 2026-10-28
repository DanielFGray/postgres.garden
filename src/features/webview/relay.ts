import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Cause, Context, Effect, Layer, Option } from "effect";
import { webviewRelayRoutes } from "../../../server/apiSchema";
import { RelayFailure, RelayReply, type RelayRequest } from "./relayProtocol";

/**
 * The HTTP client the host relays with. The workbench is served from the
 * server's own origin, so the session cookie travels with a relayed request
 * exactly as it does with a workbench one.
 */
export const relayHttpClient = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
);

/**
 * The origin a relayed request is resolved against: the page hosting the
 * workbench, which is also the origin that holds the session cookie.
 */
export const RelayOrigin = Context.Reference<string>("postgres-garden/RelayOrigin", {
  defaultValue: () => window.location.origin,
});

const parseRelayUrl = Option.liftThrowable((path: string, origin: string) => new URL(path, origin));

/**
 * Resolves a relayed path against the host's own origin, and only if the result
 * is a route the contract serves.
 *
 * The relay sends the session cookie, so a webview that could choose the URL
 * could act as the signed-in visitor anywhere on the origin. Resolving before
 * matching is what makes the check sound: `/api/playgrounds/..` matches the
 * `:hash` pattern as text but resolves to `/api`, a different route.
 */
const resolveRelayUrl = (path: string, method: string, origin: string) =>
  Option.flatMap(parseRelayUrl(path, origin), (url) =>
    url.origin === origin &&
    // An encoded slash or backslash survives into a path segment, so a
    // `:param` would match text the server later decodes into more segments.
    // Refusing it keeps one segment meaning one segment.
    !/%2f|%5c/i.test(url.pathname) &&
    webviewRelayRoutes.some((route) => route.method === method && route.pattern.test(url.pathname))
      ? Option.some(url)
      : Option.none(),
  );

/**
 * Makes one HTTP request on a webview's behalf and posts the raw answer back.
 *
 * The host adds only what the webview cannot: its own origin and the session
 * cookie. It does not read or reshape the body, because the webview's own API
 * client decodes it against the contract. Keeping the host dumb is what stops a
 * second, hand-written client growing here.
 */
/**
 * Turns one relayed request into the reply that goes back over the wire.
 *
 * Everything the relay decides lives here, and the HTTP client comes from the
 * context, so a test can drive the whole path with a stub client instead of a
 * browser.
 */
export const relayReply = Effect.fn("relayReply")(function* (request: RelayRequest) {
  const failure = (message: string) =>
    new RelayFailure({ type: "api-relay-failure", id: request.id, message });

  const url = resolveRelayUrl(request.path, request.method, yield* RelayOrigin);
  if (Option.isNone(url)) {
    yield* Effect.logWarning(
      "A webview asked the relay for a route the contract does not serve",
    ).pipe(Effect.annotateLogs({ method: request.method, path: request.path }));
    return failure(`${request.method} ${request.path} is not an endpoint this app serves`);
  }

  return yield* Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(
      HttpClientRequest.make(request.method)(url.value, {
        headers: request.headers,
        body: Option.match(request.body, {
          onNone: () => HttpBody.empty,
          // Setting a body overwrites content-type from the body's own
          // metadata, so the request's type has to be handed over with it or
          // every relayed call arrives as text/plain.
          onSome: (text) => HttpBody.text(text, request.headers["content-type"]),
        }),
      }),
    );
    const body = yield* response.text;
    return new RelayReply({
      type: "api-relay-reply",
      id: request.id,
      status: response.status,
      headers: response.headers,
      body,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(failure(`Could not reach the server: ${Cause.pretty(cause)}`)),
    ),
  );
});
