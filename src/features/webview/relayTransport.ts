import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Context, Effect, ManagedRuntime, Match, Option } from "effect";
import * as S from "effect/Schema";
import { ApiCaller, type ClientFailure, type PgGardenClient } from "../../httpapi-client";
import {
  RelayMethod,
  RelayRequest,
  type RelayRequestEncoded,
  RelayResponse,
} from "./relayProtocol";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

/**
 * The duplex message channel a webview shares with the extension host.
 *
 * In a webview it is the VSCode API paired with `window` message events. Naming
 * it lets a test drive the transport below against the real host handler, which
 * is the only way the relay's correctness can be checked without a browser.
 */
export type RelayChannel<Encoded> = {
  readonly post: (message: Encoded | RelayRequestEncoded) => void;
  /** Handed every message the host sends. The one boundary decode is inside. */
  readonly subscribe: (handler: (message: unknown) => void) => void;
};

/** The channel a real webview runs on. */
export const vsCodeChannel = <Encoded>(): RelayChannel<Encoded> => {
  const vscode = acquireVsCodeApi();
  return {
    post: (message) => vscode.postMessage(message),
    subscribe: (handler) =>
      window.addEventListener("message", (event: MessageEvent) => handler(event.data)),
  };
};

/**
 * The relay discards the request's authority and resolves the path against the
 * host's own origin, so the only thing a base URL has to be here is a valid
 * absolute URL.
 */
const relayBaseUrl = "http://webview-relay.invalid";

/** How long a webview waits for the host before giving up on one call. */
const relayTimeout = "15 seconds";

/**
 * An `HttpClient` whose transport is the extension host.
 *
 * A webview cannot send the session cookie itself, so each request crosses the
 * channel as plain data and the host makes it from the workbench. The client
 * above this is the ordinary generated client, which is what keeps a webview's
 * calls, their arguments and their results all coming from the contract.
 */
export const makeRelayTransport = <Encoded>(channel: RelayChannel<Encoded>) => {
  const pending = new Map<string, (response: RelayResponse) => void>();
  let nextRequestId = 0;

  // The host answers on the same channel the webview's own messages arrive on,
  // so anything that is not a reply belongs to the feature and is left to its
  // own listener. A reply that does not decode leaves its call to time out,
  // which surfaces as a failure rather than as silence.
  channel.subscribe((message) => {
    Option.map(S.decodeUnknownOption(RelayResponse)(message), (response) => {
      Option.map(Option.fromNullishOr(pending.get(response.id)), (resolve) => resolve(response));
    });
  });

  return HttpClient.layerMergedContext(
    Effect.succeed(
      HttpClient.make((request, url, signal) =>
        Effect.gen(function* () {
          const encodeFailed = (cause: unknown) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({ request, cause }),
            });

          const webRequest = yield* HttpClientRequest.toWeb(request, { signal }).pipe(
            Effect.mapError(
              (cause) =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.InvalidUrlError({ request, cause }),
                }),
            ),
          );

          const body =
            webRequest.body === null
              ? Option.none<string>()
              : Option.some(
                  yield* Effect.tryPromise({
                    try: () => webRequest.text(),
                    catch: encodeFailed,
                  }),
                );

          const id = String(++nextRequestId);
          const message = yield* S.encodeEffect(RelayRequest)(
            new RelayRequest({
              type: "api-relay-request",
              id,
              // `HttpClientRequest.method` is a plain string, so the method is
              // decoded here for the same reason the headers are: what crosses
              // the wire is only ever what the relay contract names.
              method: yield* S.decodeUnknownEffect(RelayMethod)(request.method).pipe(
                Effect.mapError(encodeFailed),
              ),
              path: `${url.pathname}${url.search}`,
              // Decoding here drops every header the relay does not carry, so
              // the wire value cannot hold one the host would refuse.
              headers: yield* S.decodeUnknownEffect(RelayRequest.fields.headers)(
                request.headers,
              ).pipe(Effect.mapError(encodeFailed)),
              body,
            }),
          ).pipe(Effect.mapError(encodeFailed));

          const response = yield* Effect.callback<RelayResponse>((resume) => {
            pending.set(id, (reply) => {
              // The cleanup below runs only on interruption, so a reply that
              // arrives normally has to drop its own entry.
              pending.delete(id);
              resume(Effect.succeed(reply));
            });
            channel.post(message);
            return Effect.sync(() => {
              pending.delete(id);
            });
          }).pipe(
            Effect.timeoutOrElse({
              duration: relayTimeout,
              orElse: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "The extension host did not answer in time",
                    }),
                  }),
                ),
            }),
          );

          return yield* Match.value(response).pipe(
            Match.discriminator("type")("api-relay-reply", (reply) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  // A status that forbids a body rejects even an empty string,
                  // and an empty body is the same as none to the client above.
                  new Response(reply.body === "" ? null : reply.body, {
                    status: reply.status,
                    headers: reply.headers,
                  }),
                ),
              ),
            ),
            Match.discriminator("type")("api-relay-failure", (failure) =>
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    description: failure.message,
                  }),
                }),
              ),
            ),
            Match.exhaustive,
          );
        }),
      ),
    ),
  );
};

/** Gives a sandboxed webview the same typed API client the workbench uses. */
export const createWebviewApiClient = <Message, Encoded>(options: {
  readonly feature: string;
  /** Every message this webview may send the host, so `postMessage` is typed. */
  readonly messages: S.Codec<Message, Encoded>;
  readonly channel: RelayChannel<Encoded>;
}) => {
  // A webview has no layer graph of its own. The runtime builds the caller once,
  // on the first call, and keeps it for the webview's lifetime.
  const caller = ManagedRuntime.make(
    ApiCaller.layer({
      baseUrl: relayBaseUrl,
      transport: makeRelayTransport(options.channel),
      feature: options.feature,
    }),
  );

  return {
    /** Makes one call against the contract, attributed to a named UI action. */
    apiCall: <A, E extends ClientFailure>(
      action: string,
      run: (api: PgGardenClient) => Effect.Effect<A, E>,
    ) =>
      caller.contextEffect.pipe(
        Effect.flatMap((context) => Context.get(context, ApiCaller).call(action, run)),
      ),
    /** Sends one of the feature's own messages to the extension host. */
    postMessage: (message: Message) =>
      S.encodeEffect(options.messages)(message).pipe(
        Effect.map((encoded) => {
          options.channel.post(encoded);
        }),
      ),
  };
};
