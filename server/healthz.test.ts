/**
 * GET /healthz against the platform health contract.
 *
 * Run: bun vitest run server/healthz.test.ts
 */

import { expect, layer } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { vi } from "vitest";
import { DatabaseLive } from "./db.js";
import { HttpApiLive } from "./apiHandlers.js";

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

/** In-process web handler backed by the Effect HttpApi, as in auth.test.ts. */
class WebHandler extends Context.Service<
  WebHandler,
  { readonly fetch: (request: Request) => Promise<Response> }
>()("test/HealthzWebHandler") {
  static layer = Layer.effect(
    WebHandler,
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiLive.pipe(
            Layer.provide(HttpServer.layerServices),
            Layer.provide(DatabaseLive),
            Layer.provideMerge(commitEnv),
          ),
        ),
      ),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(Effect.map(({ handler }) => ({ fetch: handler }))),
  );
}

const getHealthz = Effect.fnUntraced(function* () {
  const { fetch } = yield* WebHandler;
  const response = yield* Effect.tryPromise(() => fetch(new Request("http://localhost/healthz")));
  const body = yield* Effect.tryPromise(() => response.json());
  return { status: response.status, body };
});

layer(WebHandler.layer, { timeout: "30 seconds" })("GET /healthz", (it) => {
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
