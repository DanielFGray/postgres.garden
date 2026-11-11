/**
 * GET /healthz against the platform health contract.
 *
 * Run: bun vitest run server/healthz.test.ts
 */

import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { DependencyUnavailable, Readiness } from "./ready.js";
import {
  makeTestHttpClientLive,
  origin,
  workerRunning,
  type HealthDependencies,
} from "./test/apiHarness.js";
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
  const response = yield* HttpClient.get(`${origin}/healthz`);
  const body = yield* response.json;
  return { status: response.status, body };
});

/** The API with `health` as its health dependencies. */
const healthClient = (health?: HealthDependencies) =>
  makeTestHttpClientLive({ overrides: commitEnv, health });

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

describe("GET /healthz", () => {
  it.effect(
    "answers 200 with the commit when the database answers",
    () =>
      Effect.gen(function* () {
        const { status, body } = yield* getHealthz().pipe(Effect.provide(healthClient()));
        expect(status).toBe(200);
        expect(body).toEqual({ status: "ok", commit: COMMIT });
      }),
    30_000,
  );

  it.effect(
    'answers 503 naming "worker" when the worker runner has stopped',
    () =>
      Effect.gen(function* () {
        const { status, body } = yield* getHealthz().pipe(
          Effect.provide(healthClient(Layer.mergeAll(Readiness.layer, workerStopped))),
        );
        expect(status).toBe(503);
        expect(body).toEqual({ status: "error", commit: COMMIT, failed: ["worker"] });
      }),
    30_000,
  );

  it.effect(
    "answers 503 naming the database when the database does not answer",
    () =>
      Effect.gen(function* () {
        const { status, body } = yield* getHealthz().pipe(
          Effect.provide(healthClient(Layer.mergeAll(databaseDown, workerRunning))),
        );
        expect(status).toBe(503);
        expect(body).toEqual({ status: "error", commit: COMMIT, failed: ["database"] });
      }),
    30_000,
  );
});
