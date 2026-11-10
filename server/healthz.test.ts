/**
 * GET /healthz against the platform health contract.
 *
 * Run: bun vitest run server/healthz.test.ts
 */

import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { vi } from "vitest";
import { makeTestHttpClientLive, origin } from "./test/apiHarness.js";

// The 503 test needs a Postgres that is down, which the suite cannot arrange.
// The probe is swapped for a failure; the handler, its schema and the mapping
// from dependency name to `failed` all run as in production.
const databaseDown = vi.hoisted(() => ({ on: false }));

// The worker's runner is started only by the server, so the test flips the flag
// the probe reads. The probe itself is the real one.
const workerStopped = vi.hoisted(() => ({ on: false }));

// @effect-diagnostics asyncFunction:off
vi.mock("./worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worker.js")>();
  return { ...actual, workerFailed: () => workerStopped.on };
});

// The factory is async because vitest's `importOriginal` is; it is a test-harness
// API, not Effect control flow.
// @effect-diagnostics asyncFunction:off
vi.mock("./ready.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ready.js")>();
  const { Effect } = await import("effect");
  return {
    ...actual,
    checkDependencies: Effect.suspend(() =>
      databaseDown.on
        ? Effect.fail(
            new actual.DependencyUnavailable({
              dependency: "postgres (owner pool)",
              message: "connection refused",
            }),
          )
        : actual.checkDependencies,
    ),
  };
});

const COMMIT = "9d1e4c2";

// Config reads a provider that is built once from the environment at startup, so
// a value set later is not seen. The handler reads GIT_COMMIT per request, so the
// test installs a provider that carries it.
const commitEnv = Layer.succeed(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnv({ env: { ...process.env, GIT_COMMIT: COMMIT } }),
);

const getHealthz = Effect.fnUntraced(function* () {
  const response = yield* HttpClient.get(`${origin}/healthz`);
  const body = yield* response.json;
  return { status: response.status, body };
});

layer(makeTestHttpClientLive(commitEnv), { timeout: "30 seconds" })("GET /healthz", (it) => {
  it.effect("answers 200 with the commit when the database answers", () =>
    Effect.gen(function* () {
      const { status, body } = yield* getHealthz();
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok", commit: COMMIT });
    }),
  );

  it.effect('answers 503 naming "worker" when the worker runner has stopped', () =>
    Effect.gen(function* () {
      workerStopped.on = true;
      const { status, body } = yield* getHealthz().pipe(
        Effect.ensuring(Effect.sync(() => (workerStopped.on = false))),
      );
      expect(status).toBe(503);
      expect(body).toEqual({ status: "error", commit: COMMIT, failed: ["worker"] });
    }),
  );

  it.effect("answers 503 naming the database when the database does not answer", () =>
    Effect.gen(function* () {
      databaseDown.on = true;
      const { status, body } = yield* getHealthz().pipe(
        Effect.ensuring(Effect.sync(() => (databaseDown.on = false))),
      );
      expect(status).toBe(503);
      expect(body).toEqual({ status: "error", commit: COMMIT, failed: ["database"] });
    }),
  );
});
