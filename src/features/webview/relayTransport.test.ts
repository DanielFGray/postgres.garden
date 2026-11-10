import { expect, it } from "@effect/vitest";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Array, Effect, Option, Ref } from "effect";
import * as S from "effect/Schema";
import { RelayOrigin, relayReply } from "./relay";
import {
  RelayRequest,
  type RelayMethod,
  type RelayRequestEncoded,
  RelayResponse,
} from "./relayProtocol";
import { type RelayChannel, createWebviewApiClient } from "./relayTransport";

const origin = "http://localhost:3000";

/** What the stub server was asked for, so a test can assert on the real request. */
type Seen = {
  readonly method: string;
  readonly url: string;
  readonly contentType: Option.Option<string>;
  readonly body: string;
};

const refuseToSend = HttpClient.layerMergedContext(
  Effect.succeed(HttpClient.make(() => Effect.die("the relay must not send this"))),
);

/** A reply body as the server would send it, already serialised. */
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

/**
 * One user, as the server really sends it. `created_at` matters: it crosses
 * the relay as a string, and only the webview's own client turns it into a
 * `Date`, so a `Date` on arrival shows the webview decoded the reply.
 */
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "ada",
  name: "Ada",
  avatar_url: null,
  bio: "",
  role: "user",
  is_verified: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const userJson = JSON.stringify({ user });

/**
 * Joins a webview's client to the host relay the way a real webview is joined
 * to it, with `structuredClone` standing in for `postMessage`, so every hop
 * decodes exactly what it decodes in the browser.
 */
const connect = Effect.fnUntraced(function* (respond: (seen: Seen) => Response) {
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([]);

  const stubServer = HttpClient.layerMergedContext(
    Effect.succeed(
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
          const record: Seen = {
            method: request.method,
            url: url.toString(),
            contentType: Option.fromNullishOr(web.headers.get("content-type")),
            body: web.body === null ? "" : yield* Effect.promise(() => web.text()),
          };
          yield* Ref.update(seen, Array.append(record));
          return HttpClientResponse.fromWeb(request, respond(record));
        }),
      ),
    ),
  );

  type Subscriber = Parameters<RelayChannel<RelayRequestEncoded>["subscribe"]>[0];
  const subscribers: Array<Subscriber> = [];
  const runHost = (message: RelayRequestEncoded) =>
    Effect.gen(function* () {
      const request = yield* S.decodeEffect(RelayRequest)(message);
      // The host adds no credentials of its own in this test: the stub server
      // answers whatever arrives.
      const reply = yield* relayReply(request, {});
      const encoded = yield* S.encodeEffect(RelayResponse)(reply);
      // postMessage hands the other side a structured clone, never the value.
      for (const subscriber of subscribers) subscriber(structuredClone(encoded));
    }).pipe(Effect.provide(stubServer), Effect.provideService(RelayOrigin, origin), Effect.orDie);

  const context = yield* Effect.context<never>();
  const channel: RelayChannel<RelayRequestEncoded> = {
    // The one place this test runs an effect: it stands in for the extension
    // host, which really does start its own work when a message arrives.
    post: (message) => void Effect.runPromiseWith(context)(runHost(structuredClone(message))),
    subscribe: (handler) => subscribers.push(handler),
  };

  // This test sends the host no messages of its own, only relayed requests.
  const client = createWebviewApiClient({ feature: "relay-test", messages: S.Never, channel });

  return { client, request: Ref.get(seen).pipe(Effect.map(Array.get(0))) };
});

it.effect("a GET crosses the relay and comes back decoded against the contract", () =>
  Effect.gen(function* () {
    const { client, request } = yield* connect(() => json(userJson));

    const result = yield* client.apiCall("test", (api) => api.apiUsers.me());

    expect(Option.map(Option.fromNullishOr(result.user), (user) => user.username)).toStrictEqual(
      Option.some("ada"),
    );
    expect(Option.map(yield* request, (seen) => [seen.method, seen.url])).toStrictEqual(
      Option.some(["GET", `${origin}/api/me`]),
    );
    // Decoding happens here, in the webview, against the contract.
    expect(
      Option.map(Option.fromNullishOr(result.user), (user) => user.created_at instanceof Date),
    ).toStrictEqual(Option.some(true));
  }),
);

it.effect("a PATCH keeps the JSON content type its body would otherwise overwrite", () =>
  Effect.gen(function* () {
    const { client, request } = yield* connect(() => json(JSON.stringify(user)));

    yield* client.apiCall("test", (api) =>
      api.apiUsers.patchMe({ payload: { name: "Ada Lovelace" } }),
    );

    expect(
      Option.map(yield* request, (seen) => [seen.method, seen.contentType, seen.body]),
    ).toStrictEqual(
      Option.some(["PATCH", Option.some("application/json"), '{"name":"Ada Lovelace"}']),
    );
  }),
);

it.effect("a header the relay does not carry is dropped before the wire", () =>
  Effect.gen(function* () {
    const decoded = yield* S.decodeUnknownEffect(RelayRequest)({
      type: "api-relay-request",
      id: "1",
      method: "GET",
      path: "/api/me",
      headers: { authorization: "Bearer stolen", "content-type": "application/json" },
    });

    expect(Object.keys(decoded.headers)).toStrictEqual(["content-type"]);
  }),
);

const refused = (method: RelayMethod, path: string) =>
  relayReply(
    new RelayRequest({
      type: "api-relay-request",
      id: "1",
      method,
      path,
      headers: {},
      body: Option.none(),
    }),
    {},
  ).pipe(
    Effect.provide(refuseToSend),
    Effect.provideService(RelayOrigin, origin),
    Effect.map((reply) => reply.type),
  );

it.effect("a route outside the webview contract is refused instead of sent", () =>
  Effect.gen(function* () {
    expect(yield* refused("POST", "/webhooks/gh_sponsor")).toBe("api-relay-failure");
  }),
);

it.effect("a path that escapes its route with .. is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("GET", "/api/playgrounds/../me/emails")).toBe("api-relay-failure");
  }),
);

it.effect("an absolute URL on another host is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("GET", "https://evil.example/api/me")).toBe("api-relay-failure");
  }),
);

// A relative path can still name another host: the browser resolves
// "//host/x" and "http://origin@host/x" to that host, not to ours.
it.effect("a scheme-relative path pointing at another host is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("GET", "//evil.example/api/me")).toBe("api-relay-failure");
  }),
);

it.effect("a path that hides another host behind userinfo is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("GET", `${origin}@evil.example/api/me`)).toBe("api-relay-failure");
  }),
);

it.effect("a method the contract does not pair with that path is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("DELETE", "/api/me/has-password")).toBe("api-relay-failure");
  }),
);

it.effect("an encoded slash inside a path parameter is refused", () =>
  Effect.gen(function* () {
    expect(yield* refused("GET", "/api/playgrounds/a%2F..%2F..%2Fwebhooks")).toBe(
      "api-relay-failure",
    );
  }),
);
