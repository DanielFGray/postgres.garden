import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as S from "effect/Schema";
import { RelayFailure, RelayReply, RelayRequest, RelayResponse } from "./relayProtocol";

/**
 * The relay's one hard constraint: `postMessage` carries plain data, so what
 * crosses it has to be the encoded form. These prove a value survives the real
 * `structuredClone` and decodes back to what was sent, which is what lets the
 * webview run the generated API client over this transport.
 */
const roundTrip = <A, I>(schema: S.Codec<A, I>, value: A) =>
  Effect.gen(function* () {
    const encoded = yield* S.encodeEffect(schema)(value);
    return yield* S.decodeUnknownEffect(schema)(structuredClone(encoded));
  });

it.effect("carries a request with a body across the transport", () =>
  Effect.gen(function* () {
    const decoded = yield* roundTrip(
      RelayRequest,
      new RelayRequest({
        type: "api-relay-request",
        id: "7",
        method: "PUT",
        path: "/api/playgrounds/abc123",
        headers: { "content-type": "application/json", "x-ui-action": "playgrounds.update" },
        body: Option.some('{"name":"renamed"}'),
      }),
    );

    expect(decoded.method).toBe("PUT");
    expect(decoded.path).toBe("/api/playgrounds/abc123");
    expect(decoded.headers["x-ui-action"]).toBe("playgrounds.update");
    expect(decoded.body).toEqual(Option.some('{"name":"renamed"}'));
  }),
);

it.effect("carries a request with no body as an absent body", () =>
  Effect.gen(function* () {
    const decoded = yield* roundTrip(
      RelayRequest,
      new RelayRequest({
        type: "api-relay-request",
        id: "1",
        method: "GET",
        path: "/api/me",
        headers: {},
        body: Option.none(),
      }),
    );

    expect(decoded.body).toEqual(Option.none());
  }),
);

it.effect("carries a reply's status and headers back to the webview", () =>
  Effect.gen(function* () {
    const decoded = yield* roundTrip(
      RelayResponse,
      new RelayReply({
        type: "api-relay-reply",
        id: "7",
        status: 423,
        headers: { "content-type": "application/json" },
        body: '{"error":"Account locked"}',
      }),
    );

    expect(decoded).toEqual(
      new RelayReply({
        type: "api-relay-reply",
        id: "7",
        status: 423,
        headers: { "content-type": "application/json" },
        body: '{"error":"Account locked"}',
      }),
    );
  }),
);

it.effect("tells a failure to reach the server apart from a reply", () =>
  Effect.gen(function* () {
    const decoded = yield* roundTrip(
      RelayResponse,
      new RelayFailure({
        type: "api-relay-failure",
        id: "7",
        message: "You're offline",
      }),
    );

    expect(decoded.type).toBe("api-relay-failure");
  }),
);
