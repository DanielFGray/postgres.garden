import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Random } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { RateLimiter } from "effect/persistence/RateLimiter";
import { PgGardenApi, RateLimitMiddleware } from "./apiSchema.js";
import { asRoot, DatabaseLive } from "./db.js";
import { TooManyRequests } from "./errors.js";
import { RateLimitMiddlewareLive, rules } from "./rateLimit.js";
import { RateLimiterMemory } from "./services/rateLimiter.js";
import { makeTestHttpClientLive, origin } from "./test/apiHarness.js";
import { RateLimiterStoreFails, RateLimiterStoreSilent } from "./test/rateLimiterStores.js";

describe("rate-limit rules", () => {
  it("cover exactly the endpoints that carry the middleware", () => {
    const limited = Object.values(PgGardenApi.groups).flatMap((group) =>
      Object.values(group.endpoints)
        .filter((endpoint) => endpoint.middlewares.has(RateLimitMiddleware))
        .map((endpoint) => `${group.identifier}:${endpoint.identifier}`),
    );
    expect(limited.sort()).toEqual(Object.keys(rules).sort());
  });
});

describe("rate limits", { timeout: 30_000 }, () => {
  it.live("login answers 429 after the address limit; another address is not affected", () =>
    Effect.gen(function* () {
      const [ipA, ipB] = [yield* testAddress, yield* testAddress];

      for (let i = 0; i < rules["auth:login"].limit; i++) {
        expect((yield* login(ipA)).status).toBe(401);
      }

      const blocked = yield* login(ipA);
      expect(blocked.status).toBe(429);
      const body = yield* HttpClientResponse.schemaBodyJson(TooManyRequests)(blocked);
      expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      expect((yield* login(ipB)).status).toBe(401);
    }).pipe(Effect.provide(limitedClient())),
  );

  it.live("a user rule counts per signed-in user, not per address", () =>
    Effect.gen(function* () {
      const ip = yield* testAddress;
      const suffix = yield* Random.nextIntBetween(0, 0xffffff);
      const [userA, userB] = [`test_rl_a_${suffix}`, `test_rl_b_${suffix}`];
      yield* Effect.addFinalizer(() => deleteUsers([userA, userB]));
      const cookieA = yield* signIn(userA);
      const cookieB = yield* signIn(userB);

      for (let i = 0; i < rules["apiUsers:createMeEmail"].limit; i++) {
        const response = yield* addEmail(cookieA, `a${i}_${userA}@example.com`, ip);
        expect(response.status).toBe(200);
      }

      const blocked = yield* addEmail(cookieA, `a_last_${userA}@example.com`, ip);
      expect(blocked.status).toBe(429);

      const otherUser = yield* addEmail(cookieB, `b0_${userB}@example.com`, ip);
      expect(otherUser.status).toBe(200);
    }).pipe(Effect.scoped, Effect.provide([limitedClient(), DatabaseLive])),
  );

  for (const [state, limiter] of [
    ["fails", RateLimiterStoreFails],
    ["never answers", RateLimiterStoreSilent],
  ] as const) {
    it.live(`login passes and forgot-password is refused when the store ${state}`, () =>
      Effect.gen(function* () {
        const ip = yield* testAddress;

        expect((yield* login(ip)).status).toBe(401);

        const refused = yield* post("/api/forgotPassword", { email: "nobody@example.com" }, ip);
        expect(refused.status).toBe(429);
        const body = yield* HttpClientResponse.schemaBodyJson(TooManyRequests)(refused);
        expect(body.retryAfterSeconds).toBe(60);
      }).pipe(Effect.provide(limitedClient(limiter))),
    );
  }
});

/** The API with enforcing limits that count against `limiter`, keyed by `x-real-ip`. */
const limitedClient = (limiter: Layer.Layer<RateLimiter> = RateLimiterMemory) =>
  makeTestHttpClientLive(
    Layer.empty,
    RateLimitMiddlewareLive.pipe(
      Layer.provide(limiter),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ TRUSTED_PROXY_HEADER: "x-real-ip" })),
      ),
    ),
  );

/** An address in TEST-NET-3, so a run never counts against a real caller. */
const testAddress = Random.nextIntBetween(1, 254).pipe(Effect.map((n) => `203.0.113.${n}`));

const post = Effect.fnUntraced(function* (
  path: string,
  body: Readonly<Record<string, string>>,
  ip: string,
  cookie = "",
) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(`${origin}${path}`).pipe(
    HttpClientRequest.setHeaders({ "x-real-ip": ip, cookie }),
    HttpClientRequest.bodyJson(body),
  );
  return yield* client.execute(request);
});

const login = (ip: string) =>
  post("/login", { id: "nobody_rate_limit", password: "not the password" }, ip);

const addEmail = (cookie: string, email: string, ip: string) =>
  post("/api/me/emails", { email }, ip, cookie);

/** Creates a verified user through the testing routes and returns its session cookie. */
const signIn = Effect.fnUntraced(function* (username: string) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(`${origin}/api/testing/login`, {
      urlParams: { username, verified: "true" },
    }),
  );
  return response.headers["set-cookie"]?.split(";")[0] ?? "";
});

const deleteUsers = (usernames: ReadonlyArray<string>) =>
  asRoot((db) => db.deleteFrom("app_public.users").where("username", "in", usernames)).pipe(
    Effect.ignore,
  );
