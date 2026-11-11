/**
 * Authentication integration tests.
 *
 * Uses @effect/vitest to run each test as an Effect, with one API server for
 * the suite (`TestApi`) and the database pool and Valkey client it uses, for
 * setup and cleanup.
 *
 * Run: bun vitest run server/auth.test.ts
 */

import { describe, expect, layer } from "@effect/vitest";
import { Effect, Random, pipe } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { PgRootDB } from "./db.js";
import { Redis } from "effect/persistence/Redis";
import { sessionKeyOf } from "./services/sessionService.js";
import { TestApi } from "./test/apiHarness.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Unique enough to keep concurrent test users apart. */
const randomSuffix = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => n.toString(16).padStart(8, "0")),
);

const parseCookie = (res: { readonly setCookie: string | undefined }): string =>
  res.setCookie?.split(";")[0] ?? "";

const sessionIdFromCookie = (cookie: string): string =>
  decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";

// ---------------------------------------------------------------------------
// Effectful helpers (all yieldable — no floating promises)
// ---------------------------------------------------------------------------

/** Send a request to the suite's API server. */
const send = Effect.fnUntraced(function* (
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown; cookie?: string },
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.make(method)(path, {
    urlParams: opts?.query,
    headers: opts?.cookie ? { Cookie: opts.cookie } : undefined,
  });
  const response = yield* client.execute(
    opts?.body === undefined ? request : yield* HttpClientRequest.bodyJson(request, opts.body),
  );

  return {
    status: response.status,
    setCookie: response.headers["set-cookie"],
    json: <T = unknown>() => response.json.pipe(Effect.map((body) => body as T)),
    text: () => response.text,
  } as const;
});

/** Send a request to the public API. */
const http = (method: "GET" | "POST", path: string, opts?: { body?: unknown; cookie?: string }) =>
  send(method, path, opts);

/** Send a request to the `/api/testing` routes. */
const testingHttp = (
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown; cookie?: string },
) => send(method, `/api/testing${path}`, opts);

/** Delete a user by username. Errors are swallowed (cleanup must not fail tests). */
const deleteUser = (username: string) =>
  pipe(
    PgRootDB.use((db) =>
      db.all(db.connection.deleteFrom("app_public.users").where("username", "=", username)),
    ),
    Effect.ignore,
  );

/** Run an effect with guaranteed user cleanup afterward. */
const withCleanup = <A, E, R>(username: string, effect: Effect.Effect<A, E, R>) =>
  Effect.ensuring(effect, deleteUser(username));

/** Register a user via the HTTP API. */
const register = (username: string) =>
  http("POST", "/api/auth/register", {
    body: {
      username,
      email: `${username}@test.com`,
      password: "TestPassword123!",
    },
  });

/** Register, then return the session cookie string. */
const registerAndGetCookie = (username: string) =>
  pipe(register(username), Effect.map(parseCookie));

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

layer(TestApi, { excludeTestServices: true, timeout: "30 seconds" })("Auth API", (it) => {
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

            const setCookie = res.setCookie;
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
    it.effect("/api/me returns user for valid session", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_me_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const cookie = yield* registerAndGetCookie(username);

            const res = yield* http("GET", "/api/me", { cookie });
            const body = yield* res.json<{ user: { username: string } | null }>();

            expect(res.status).toBe(200);
            expect(body.user?.username).toBe(username);
          }),
        );
      }),
    );

    it.effect("/api/me returns null for invalid session token", () =>
      Effect.gen(function* () {
        const res = yield* http("GET", "/api/me", {
          cookie: "session=invalid.token",
        });
        const body = yield* res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ user: null });
      }),
    );

    it.effect("/api/me returns null after session evicted from Valkey", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_evict_${suffix}`;
        return withCleanup(
          username,
          Effect.gen(function* () {
            const cookie = yield* registerAndGetCookie(username);
            const id = sessionIdFromCookie(cookie);

            // Simulate expiration by deleting the Valkey key
            const sessionKey = yield* sessionKeyOf;
            yield* Redis.use((redis) => redis.send("DEL", sessionKey(id)));

            const res = yield* http("GET", "/api/me", { cookie });
            const body = yield* res.json();

            expect(res.status).toBe(200);
            expect(body).toEqual({ user: null });
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

            const res = yield* http("POST", "/api/auth/login", {
              body: {
                id: `${username}@test.com`,
                password: "TestPassword123!",
              },
            });
            const body = yield* res.json<{ username: string }>();

            expect(res.status).toBe(200);
            expect(body.username).toBe(username);
            expect(res.setCookie).toContain("session=");
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

            const res = yield* http("POST", "/api/auth/login", {
              body: { id: username, password: "TestPassword123!" },
            });

            expect(res.status).toBe(200);
            expect(res.setCookie).toContain("session=");
          }),
        );
      }),
    );

    // `app_private.login` locks an account after 3 failures in 5 minutes. The
    // failures only count if each rejected login commits its counter write.
    it.effect("locks the account after repeated wrong passwords", () =>
      Effect.flatMap(randomSuffix, (suffix) => {
        const username = `test_lockout_${suffix}`;
        const login = (password: string) =>
          http("POST", "/api/auth/login", { body: { id: username, password } });
        return withCleanup(
          username,
          Effect.gen(function* () {
            yield* register(username);

            const wrong = yield* Effect.forEach([1, 2, 3], () => login("WrongPassword999!"));
            const correct = yield* login("TestPassword123!");

            expect(wrong.map((res) => res.status)).toEqual([401, 401, 401]);
            expect(correct.status).toBe(423);
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
            const loginRes = yield* http("POST", "/api/auth/login", {
              body: { id: username, password: "TestPassword123!" },
            });
            const cookie = parseCookie(loginRes);

            // Logout
            const logoutRes = yield* http("POST", "/api/auth/logout", { cookie });
            expect(logoutRes.status).toBe(200);

            // Old session should be dead
            const meRes = yield* http("GET", "/api/me", { cookie });
            const meBody = yield* meRes.json();
            expect(meBody).toEqual({ user: null });
          }),
        );
      }),
    );
  });

  // -- Playgrounds ---------------------------------------------------------

  describe("Playgrounds", () => {
    it.effect("an unknown playground hash answers 404", () =>
      Effect.gen(function* () {
        const response = yield* http("GET", "/api/playgrounds/nosuchhash00");

        expect(response.status).toBe(404);
      }),
    );

    it.effect("saving another user's playground forks it and keeps the files being saved", () =>
      Effect.flatMap(Effect.all([randomSuffix, randomSuffix]), ([first, second]) => {
        const owner = `owner_${first}`;
        const forker = `forker_${second}`;
        return withCleanup(
          owner,
          withCleanup(
            forker,
            Effect.gen(function* () {
              const ownerCookie = yield* registerAndGetCookie(owner);
              const created = yield* http("POST", "/api/playgrounds", {
                cookie: ownerCookie,
                body: {
                  name: "original",
                  message: "the owner's commit",
                  files: [{ path: "query.sql", content: "-- the owner's" }],
                },
              });
              expect(created.status).toBe(200);
              const { playground_hash: source } = yield* created.json<{
                playground_hash: string;
              }>();

              const forkerCookie = yield* registerAndGetCookie(forker);
              const commit = yield* http("POST", `/api/playgrounds/${source}/commits`, {
                cookie: forkerCookie,
                body: {
                  message: "the forker's commit",
                  files: [{ path: "query.sql", content: "-- the forker's" }],
                },
              });
              expect(commit.status).toBe(200);
              const fork = yield* commit.json<{
                forked: boolean;
                playground_hash: string;
                commit_id: string;
              }>();
              expect(fork.forked).toBe(true);
              expect(fork.playground_hash).not.toBe(source);

              // The commit the fork reports must hold what was saved, not the
              // snapshot the fork was copied from.
              const saved = yield* http(
                "GET",
                `/api/playgrounds/${fork.playground_hash}/commits/${fork.commit_id}`,
                { cookie: forkerCookie },
              );
              const { files, parent_id } = yield* saved.json<{
                files: ReadonlyArray<{ path: string; content: string }>;
                parent_id: string | null;
              }>();
              expect(files).toEqual([{ path: "query.sql", content: "-- the forker's" }]);

              // Its parent is the copy of the source, so the fork records what
              // it came from and the change made on top of it.
              const parent = yield* http(
                "GET",
                `/api/playgrounds/${fork.playground_hash}/commits/${parent_id}`,
                { cookie: forkerCookie },
              );
              const copied = yield* parent.json<{
                files: ReadonlyArray<{ path: string; content: string }>;
              }>();
              expect(copied.files).toEqual([{ path: "query.sql", content: "-- the owner's" }]);

              // Opening the fork loads the commit the playground names as its
              // head, which must be the save and not the copy it sits on.
              const opened = yield* http("GET", `/api/playgrounds/${fork.playground_hash}`, {
                cookie: forkerCookie,
              });
              const { head_commit_id } = yield* opened.json<{ head_commit_id: string | null }>();
              expect(head_commit_id).toBe(fork.commit_id);

              // The next save on the fork continues from that head rather than
              // from the copy that shares its timestamp.
              const second = yield* http(
                "POST",
                `/api/playgrounds/${fork.playground_hash}/commits`,
                {
                  cookie: forkerCookie,
                  body: {
                    message: "the forker's second commit",
                    files: [{ path: "query.sql", content: "-- the forker's, again" }],
                  },
                },
              );
              const continued = yield* second.json<{ parent_id: string | null; forked: boolean }>();
              expect(continued.parent_id).toBe(fork.commit_id);
              expect(continued.forked).toBe(false);
            }),
          ),
        );
      }),
    );
  });

  // -- GitHub OAuth --------------------------------------------------------

  describe("GitHub OAuth callback", () => {
    // Both cases answer before the handler reaches GitHub, so they need no
    // OAuth credentials and make no outbound request.
    const STATE = "test-oauth-state";

    it.effect("a declined consent screen reports a failure the popup can relay", () =>
      Effect.gen(function* () {
        const response = yield* http(
          "GET",
          `/auth/github/callback?error=access_denied&error_description=denied&state=${STATE}`,
          { cookie: `github_oauth_state=${STATE}` },
        );

        expect(response.status).toBe(400);
        const html = yield* response.text();
        expect(html).toContain("github-auth-failure");
        expect(html).not.toContain("github-auth-success");
        expect(html).toContain("Sign-in was declined on GitHub.");
      }),
    );

    it.effect("a state that does not match the cookie reports a failure", () =>
      Effect.gen(function* () {
        const response = yield* http("GET", `/auth/github/callback?code=abc&state=${STATE}`, {
          cookie: "github_oauth_state=a-different-state",
        });

        expect(response.status).toBe(400);
        const html = yield* response.text();
        expect(html).toContain("github-auth-failure");
        expect(html).not.toContain("github-auth-success");
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
            });
            const cookie = parseCookie(login);
            const me = yield* http("GET", "/api/me", { cookie });
            const meBody = yield* me.json<{ user: { username: string } | null }>();

            expect(login.status).toBe(302);
            expect(cookie).toContain("session=");
            expect(me.status).toBe(200);
            expect(meBody.user?.username).toBe(username);
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
            });
            const cookie = parseCookie(login);

            const logout = yield* http("POST", "/api/auth/logout", { cookie });
            const meAfter = yield* http("GET", "/api/me", { cookie });
            const meBody = yield* meAfter.json();

            expect(logout.status).toBe(200);
            expect(meAfter.status).toBe(200);
            expect(meBody).toEqual({ user: null });
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
            });

            const login = yield* testingHttp("POST", "/loginPost", {
              body: { id: username, password: "TestPassword123!" },
            });
            const cookie = parseCookie(login);

            const me = yield* http("GET", "/api/me", { cookie });
            const meBody = yield* me.json<{ user: { username: string } | null }>();

            expect(login.status).toBe(302);
            expect(me.status).toBe(200);
            expect(meBody.user?.username).toBe(username);
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
            });

            const login = yield* testingHttp("POST", "/loginPost", {
              body: { id: username, password: "TestPassword123!" },
            });
            const cookie = parseCookie(login);

            const logout = yield* http("POST", "/api/auth/logout", { cookie });
            const meAfter = yield* http("GET", "/api/me", { cookie });
            const meBody = yield* meAfter.json();

            expect(logout.status).toBe(200);
            expect(meBody).toEqual({ user: null });
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

            const login = yield* http("POST", "/api/auth/login", {
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

            const login = yield* http("POST", "/api/auth/login", {
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

            const reg = yield* http("POST", "/api/auth/register", {
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
