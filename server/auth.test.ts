/**
 * Authentication integration tests.
 *
 * Uses @effect/vitest to run each test as an Effect, with a shared layer
 * providing an in-process web handler (no TCP listener) and direct DB access
 * for setup/cleanup.
 *
 * Run: bun vitest run server/auth.test.ts
 */

import { describe, expect, layer } from "@effect/vitest";
import { Context, Effect, Layer, Random, pipe } from "effect";
import * as S from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/http";
import { asRoot, DatabaseLive } from "./db.js";
import { HttpApiLive } from "./apiHandlers.js";
import { valkey } from "./valkey.js";
import { sessionKey } from "./services/sessionService.js";
import { TestingRoutesLive } from "./testing.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** In-process web handler backed by our Effect HttpApi. */
class WebHandler extends Context.Service<
  WebHandler,
  { readonly fetch: (request: Request) => Promise<Response> }
>()("test/WebHandler") {
  static layer = Layer.effect(
    WebHandler,
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiLive.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(DatabaseLive)),
        ),
      ),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(
      Effect.map(({ handler }) => ({
        fetch: handler,
      })),
    ),
  );
}

/** In-process web handler for testing helper endpoints. */
class TestingWebHandler extends Context.Service<
  TestingWebHandler,
  { readonly fetch: (request: Request) => Promise<Response> }
>()("test/TestingWebHandler") {
  static layer = Layer.effect(
    TestingWebHandler,
    Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(TestingRoutesLive)),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(
      Effect.map(({ handler }) => ({
        fetch: handler,
      })),
    ),
  );
}

/** Shared layer: in-process HTTP + direct DB for cleanup. */
const TestLayer = Layer.mergeAll(WebHandler.layer, TestingWebHandler.layer, DatabaseLive);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Unique enough to keep concurrent test users apart. */
const randomSuffix = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => n.toString(16).padStart(8, "0")),
);

const parseCookie = (headers: Headers): string => headers.get("set-cookie")?.split(";")[0] ?? "";

const sessionIdFromCookie = (cookie: string): string =>
  decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";

// ---------------------------------------------------------------------------
// Effectful helpers (all yieldable — no floating promises)
// ---------------------------------------------------------------------------

/** Send an HTTP request through the in-process handler. */
const http = Effect.fnUntraced(function* (
  method: string,
  path: string,
  opts?: { body?: unknown; cookie?: string },
) {
  const { fetch } = yield* WebHandler;
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  if (opts?.cookie) headers["Cookie"] = opts.cookie;

  const body = opts?.body
    ? yield* S.encodeEffect(S.fromJsonString(S.Unknown))(opts.body)
    : undefined;

  const response = yield* Effect.tryPromise(() =>
    fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        body,
      }),
    ),
  );

  return {
    status: response.status,
    headers: response.headers,
    json: <T = unknown>() => Effect.tryPromise(() => response.json() as Promise<T>),
  } as const;
});

/** Delete a user by username. Errors are swallowed (cleanup must not fail tests). */
const deleteUser = (username: string) =>
  pipe(
    asRoot((db) => db.deleteFrom("app_public.users").where("username", "=", username)),
    Effect.ignore,
  );

/** Run an effect with guaranteed user cleanup afterward. */
const withCleanup = <A, E, R>(username: string, effect: Effect.Effect<A, E, R>) =>
  Effect.ensuring(effect, deleteUser(username));

/** Register a user via the HTTP API. */
const register = (username: string) =>
  http("POST", "/register", {
    body: {
      username,
      email: `${username}@test.com`,
      password: "TestPassword123!",
    },
  });

/** Register, then return the session cookie string. */
const registerAndGetCookie = (username: string) =>
  pipe(
    register(username),
    Effect.map((res) => parseCookie(res.headers)),
  );

/** Send request to /api/testing endpoints through in-process testing server. */
const testingHttp = Effect.fnUntraced(function* (
  method: string,
  path: string,
  opts?: {
    query?: Record<string, string>;
    body?: unknown;
    cookie?: string;
    redirect?: RequestRedirect;
  },
) {
  const { fetch } = yield* TestingWebHandler;
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  if (opts?.cookie) headers["Cookie"] = opts.cookie;
  const query = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const body = opts?.body
    ? yield* S.encodeEffect(S.fromJsonString(S.Unknown))(opts.body)
    : undefined;
  const response = yield* Effect.tryPromise(() =>
    fetch(
      new Request(`http://localhost/api/testing${path}${query}`, {
        method,
        headers,
        redirect: opts?.redirect,
        body,
      }),
    ),
  );

  return {
    status: response.status,
    headers: response.headers,
    json: <T = unknown>() => Effect.tryPromise(() => response.json() as Promise<T>),
  } as const;
});

const createTestUser = (
  username: string,
  options?: { verified?: "true" | "false"; password?: string },
) =>
  testingHttp("GET", "/createUser", {
    query: {
      username,
      email: `${username}@example.com`,
      verified: options?.verified ?? "true",
      password: options?.password ?? "TestPassword123!",
    },
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

layer(TestLayer, { timeout: "30 seconds" })("Auth API", (it) => {
  // -- Registration -------------------------------------------------------

  describe("Registration", () => {
    it.effect("creates user and sets session cookie", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_reg_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const res = yield* register(username);
            const body = yield* res.json<{ id: string; username: string }>();

            expect(res.status).toBe(200);
            expect(body.id).toBeDefined();
            expect(body.username).toBe(username);

            const setCookie = res.headers.get("set-cookie");
            expect(setCookie).toBeTruthy();
            expect(setCookie).toContain("session=");
          }),
        );
      }),
    );

    it.effect("rejects duplicate username", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_dup_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* register(username);
            const res = yield* register(username);
            expect(res.status).toBe(409);
          }),
        );
      }),
    );
  });

  // -- Session validation -------------------------------------------------

  describe("Session Validation", () => {
    it.effect("/me returns user for valid session", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_me_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const cookie = yield* registerAndGetCookie(username);

            const res = yield* http("GET", "/me", { cookie });
            const body = yield* res.json<{ username: string }>();

            expect(res.status).toBe(200);
            expect(body.username).toBe(username);
          }),
        );
      }),
    );

    it.effect("/me returns null for invalid session token", () =>
      Effect.gen(function* () {
        const res = yield* http("GET", "/me", {
          cookie: "session=invalid.token",
        });
        const body = yield* res.json();

        expect(res.status).toBe(200);
        expect(body).toBeFalsy();
      }),
    );

    it.effect("/me returns null after session evicted from Valkey", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_evict_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const cookie = yield* registerAndGetCookie(username);
            const id = sessionIdFromCookie(cookie);

            // Simulate expiration by deleting the Valkey key
            yield* Effect.tryPromise(() => valkey.del(sessionKey(id)));

            const res = yield* http("GET", "/me", { cookie });
            const body = yield* res.json();

            expect(res.status).toBe(200);
            expect(body).toBeFalsy();
          }),
        );
      }),
    );
  });

  // -- Login --------------------------------------------------------------

  describe("Login", () => {
    it.effect("logs in with email and returns session cookie", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_login_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* register(username);

            const res = yield* http("POST", "/login", {
              body: {
                id: `${username}@test.com`,
                password: "TestPassword123!",
              },
            });
            const body = yield* res.json<{ username: string }>();

            expect(res.status).toBe(200);
            expect(body.username).toBe(username);
            expect(res.headers.get("set-cookie")).toContain("session=");
          }),
        );
      }),
    );

    it.effect("logs in with username", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_loginusr_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* register(username);

            const res = yield* http("POST", "/login", {
              body: { id: username, password: "TestPassword123!" },
            });

            expect(res.status).toBe(200);
            expect(res.headers.get("set-cookie")).toContain("session=");
          }),
        );
      }),
    );
  });

  // -- Logout -------------------------------------------------------------

  describe("Logout", () => {
    it.effect("invalidates session after logout", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_logout_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* register(username);

            // Login for a fresh session
            const loginRes = yield* http("POST", "/login", {
              body: { id: username, password: "TestPassword123!" },
            });
            const cookie = parseCookie(loginRes.headers);

            // Logout
            const logoutRes = yield* http("POST", "/logout", { cookie });
            expect(logoutRes.status).toBe(200);

            // Old session should be dead
            const meRes = yield* http("GET", "/me", { cookie });
            const meBody = yield* meRes.json();
            expect(meBody).toBeFalsy();
          }),
        );
      }),
    );
  });

  // -- App flows using testing setup -------------------------------------

  describe("App flows with testing helpers", () => {
    it.effect("testing login session can access app /me", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const login = yield* testingHttp("GET", "/login", {
              query: { username, verified: "true", redirectTo: "/" },
              redirect: "manual",
            });
            const cookie = parseCookie(login.headers);
            const me = yield* http("GET", "/me", { cookie });
            const meBody = yield* me.json<{ username: string }>();

            expect(login.status).toBe(302);
            expect(cookie).toContain("session=");
            expect(me.status).toBe(200);
            expect(meBody.username).toBe(username);
          }),
        );
      }),
    );

    it.effect("testing login session can be logged out via app /logout", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const login = yield* testingHttp("GET", "/login", {
              query: { username, verified: "true", redirectTo: "/" },
              redirect: "manual",
            });
            const cookie = parseCookie(login.headers);

            const logout = yield* http("POST", "/logout", { cookie });
            const meAfter = yield* http("GET", "/me", { cookie });
            const meBody = yield* meAfter.json();

            expect(logout.status).toBe(200);
            expect(meAfter.status).toBe(200);
            expect(meBody).toBeFalsy();
          }),
        );
      }),
    );

    it.effect("testing loginPost session can access app /me", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* testingHttp("POST", "/register", {
              body: {
                username,
                email: `${username}@example.com`,
                password: "TestPassword123!",
              },
              redirect: "manual",
            });

            const login = yield* testingHttp("POST", "/loginPost", {
              body: { id: username, password: "TestPassword123!" },
              redirect: "manual",
            });
            const cookie = parseCookie(login.headers);

            const me = yield* http("GET", "/me", { cookie });
            const meBody = yield* me.json<{ username: string }>();

            expect(login.status).toBe(302);
            expect(me.status).toBe(200);
            expect(meBody.username).toBe(username);
          }),
        );
      }),
    );

    it.effect("testing loginPost session can be logged out via app /logout", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* testingHttp("POST", "/register", {
              body: {
                username,
                email: `${username}@example.com`,
                password: "TestPassword123!",
              },
              redirect: "manual",
            });

            const login = yield* testingHttp("POST", "/loginPost", {
              body: { id: username, password: "TestPassword123!" },
              redirect: "manual",
            });
            const cookie = parseCookie(login.headers);

            const logout = yield* http("POST", "/logout", { cookie });
            const meAfter = yield* http("GET", "/me", { cookie });
            const meBody = yield* meAfter.json();

            expect(logout.status).toBe(200);
            expect(meBody).toBeFalsy();
          }),
        );
      }),
    );

    it.effect("app /login succeeds for testing-created user by email", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* createTestUser(username, { verified: "true", password: "StrongPass123!" });

            const login = yield* http("POST", "/login", {
              body: {
                id: `${username}@example.com`,
                password: "StrongPass123!",
              },
            });
            const body = yield* login.json<{ username: string }>();

            expect(login.status).toBe(200);
            expect(body.username).toBe(username);
          }),
        );
      }),
    );

    it.effect("app /login rejects wrong password for testing-created user", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* createTestUser(username, { verified: "true", password: "StrongPass123!" });

            const login = yield* http("POST", "/login", {
              body: {
                id: username,
                password: "WrongPassword999!",
              },
            });

            expect(login.status).toBe(401);
          }),
        );
      }),
    );

    it.effect("app /register rejects duplicate username from testing-created user", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `testuser_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* createTestUser(username, { verified: "true", password: "StrongPass123!" });

            const reg = yield* http("POST", "/register", {
              body: {
                username,
                email: `${username}@duplicate.test`,
                password: "AnotherPass123!",
              },
            });

            expect(reg.status).toBe(409);
          }),
        );
      }),
    );
  });
});
