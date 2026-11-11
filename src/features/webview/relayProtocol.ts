import * as S from "effect/Schema";

/**
 * The messages a sandboxed webview and the extension host exchange so the
 * webview can reach the server.
 *
 * A webview cannot carry the session cookie, so it sends each HTTP request it
 * wants made to the host, which makes it from the workbench and sends back the
 * raw answer. Nothing on this wire is interpreted: the webview's own API client
 * built the request and decodes the reply against `PgGardenApi`, so the host
 * stays a relay rather than a second, hand-written client.
 *
 * Both sides decode what arrives with these schemas, which is the one place
 * each hop is checked. `postMessage` structured-clone strips class
 * prototypes, so a decoded value cannot be forwarded, only its encoded form.
 */
const HeaderMap = S.Record(S.String, S.String);

/**
 * The only request headers that cross the relay. A webview asks the host to
 * send a request with the session cookie on it, so a header it can choose is a
 * header it can smuggle: an `Authorization` or a forged CSRF header would reach
 * the server as if the workbench had sent it. Decoding against this struct
 * drops every other key, on both sides of the wire.
 *
 * These are the headers an `HttpApiClient` call actually produces: the body
 * type and accept from the request itself, the tracing pair, and the two the
 * client adds to attribute a call to a UI action.
 */
const RelayHeaders = S.Struct({
  accept: S.optionalKey(S.String),
  "content-type": S.optionalKey(S.String),
  traceparent: S.optionalKey(S.String),
  b3: S.optionalKey(S.String),
  "x-ui-action": S.optionalKey(S.String),
  "x-ui-feature": S.optionalKey(S.String),
});

/** Every method `HttpMethod` allows, so any request the client can build can cross. */
export const RelayMethod = S.Literals([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "QUERY",
]);
export type RelayMethod = typeof RelayMethod.Type;

export class RelayRequest extends S.Class<RelayRequest, { readonly brand: unique symbol }>(
  "RelayRequest",
)({
  type: S.Literal("api-relay-request"),
  /** Matches the reply to the call waiting for it, within one webview. */
  id: S.String,
  method: RelayMethod,
  /**
   * Path and query only. The host resolves it against its own origin and
   * refuses anything that does not land on a `WebviewApi` route, so a webview
   * can name neither another host nor a route the contract does not serve.
   */
  path: S.String,
  headers: RelayHeaders,
  /** Omitted entirely when the request has no body, so the wire stays plain data. */
  body: S.OptionFromOptionalKey(S.String),
}) {}

export class RelayReply extends S.Class<RelayReply, { readonly brand: unique symbol }>(
  "RelayReply",
)({
  type: S.Literal("api-relay-reply"),
  id: S.String,
  status: S.Int,
  headers: HeaderMap,
  body: S.String,
}) {}

/** The host could not reach the server at all, so there is no status to report. */
export class RelayFailure extends S.Class<RelayFailure, { readonly brand: unique symbol }>(
  "RelayFailure",
)({
  type: S.Literal("api-relay-failure"),
  id: S.String,
  message: S.String,
}) {}

export const RelayResponse = S.Union([RelayReply, RelayFailure]);
export type RelayResponse = (typeof RelayResponse)["Type"];

/** The reply as it crosses `postMessage`: plain data, before the webview decodes it. */
export type RelayResponseEncoded = (typeof RelayResponse)["Encoded"];

/** The request as it crosses `postMessage`, which is what a channel carries. */
export type RelayRequestEncoded = (typeof RelayRequest)["Encoded"];
