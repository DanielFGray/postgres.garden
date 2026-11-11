/**
 * GET /healthz against the platform health contract.
 *
 * Run: bun vitest run server/healthz.test.ts
 */

import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { DependencyUnavailable, Readiness } from "./ready.js";
import { makeTestApi, workerRunning } from "./test/apiHarness.js";
import { Worker } from "../worker/worker.js";

const COMMIT = "9d1e4c2";

// Config reads a provider that is built once from the environment at startup, so
// a value set later is not seen. The handler reads GIT_COMMIT per request, so the
// test installs a provider that carries it.
const commitEnv = Layer.succeed(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnv({ env: { ...process.env, GIT_COMMIT: COMMIT } }),
);

const getHealthz = Effect.fnUntraced(function* () {
  const response = yield* HttpClient.get("/healthz");
  const body = yield* response.json;
  return { status: response.status, body };
});

/** A worker whose runner has stopped, exactly as the real one reports it. */
const workerStopped = Layer.succeed(
  Worker,
  Worker.of({
    check: Effect.fail(
      new DependencyUnavailable({ dependency: "worker", message: "the worker has stopped" }),
    ),
  }),
);

// The suite cannot take Postgres down, so the owner pool's probe fails as it
// would; the handler, its schema and the mapping from dependency name to
// `failed` all run as in production.
const databaseDown = Layer.succeed(
  Readiness,
  Readiness.of({
    waitUntilReady: Effect.void,
    check: Effect.fail(
      new DependencyUnavailable({
        dependency: "postgres (owner pool)",
        message: "connection refused",
      }),
    ),
  }),
);

const cases = [
  {
    name: "answers 200 with the commit when the database answers",
    health: Layer.mergeAll(Readiness.layer, workerRunning),
    status: 200,
    body: { status: "ok", commit: COMMIT },
  },
  {
    name: 'answers 503 naming "worker" when the worker runner has stopped',
    health: Layer.mergeAll(Readiness.layer, workerStopped),
    status: 503,
    body: { status: "error", commit: COMMIT, failed: ["worker"] },
  },
  {
    name: "answers 503 naming the database when the database does not answer",
    health: Layer.mergeAll(databaseDown, workerRunning),
    status: 503,
    body: { status: "error", commit: COMMIT, failed: ["database"] },
  },
] as const;

// Each case serves the API over its own health dependencies.
for (const { name, health, status, body } of cases) {
  layer(makeTestApi({ overrides: commitEnv, health }), {
    excludeTestServices: true,
    timeout: "30 seconds",
  })("GET /healthz", (it) => {
    it.effect(name, () =>
      Effect.gen(function* () {
        const response = yield* getHealthz();
        expect(response.status).toBe(status);
        expect(response.body).toEqual(body);
      }),
    );
  });
}
