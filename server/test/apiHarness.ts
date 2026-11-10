import { type Config, Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { RateLimiter } from "effect/persistence/RateLimiter";
import type { Redis } from "effect/persistence/Redis";

import type { RateLimitMiddleware } from "../../shared/api/rateLimit.js";
import { DatabaseLive } from "../db.js";
import { RateLimitMiddlewarePassThrough } from "../rateLimit.js";
import { ApiRoutesLive } from "../runtime.js";
import { Readiness } from "../ready.js";
import { RateLimiterMemory } from "../services/rateLimiter.js";
import { Worker } from "../worker.js";
import { TestValkeyLive } from "./valkey.js";

/** A worker whose runner is up, for the health check. */
export const workerRunning = Layer.succeed(Worker, Worker.of({ check: Effect.void }));

/** What the health check reads: built over the database pools and Valkey. */
export type HealthDependencies = Layer.Layer<
  Readiness | Worker,
  never,
  Layer.Success<typeof DatabaseLive> | Redis
>;

/** The origin the in-process client sends requests to. Nothing listens on it. */
export const origin = "http://localhost";

/**
 * An HttpClient served by the app in this process, with no TCP listener: the
 * HttpApi and the `/api/testing` routes, as the dev server serves them.
 *
 * `overrides` is built under the app, so a test can replace a service the app
 * reads while it builds, such as the ConfigProvider.
 *
 * Rate limits pass every request unless a test brings `rateLimit`: suites
 * register and log in far more often than a limit allows. The enforcing layer
 * counts in memory unless it brings its own `RateLimiter`.
 *
 * The health check probes the real pools and Valkey, and a worker that runs:
 * no test starts a runner. A test brings `health` to replace either.
 */
export const makeTestHttpClientLive = ({
  overrides = Layer.empty,
  rateLimit = RateLimitMiddlewarePassThrough,
  health = Layer.mergeAll(Readiness.layer, workerRunning),
}: {
  readonly overrides?: Layer.Layer<never>;
  readonly rateLimit?: Layer.Layer<RateLimitMiddleware, Config.ConfigError, RateLimiter>;
  readonly health?: HealthDependencies;
} = {}) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ApiRoutesLive.pipe(
            Layer.provide(health),
            Layer.provide(rateLimit),
            Layer.provide(RateLimiterMemory),
            Layer.provide(HttpServer.layerServices),
            Layer.provide(DatabaseLive),
            Layer.provide(TestValkeyLive),
            Layer.provideMerge(overrides),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(
      Effect.map(({ handler }) =>
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FetchHttpClient.Fetch,
              Object.assign(
                (input: RequestInfo | URL, init?: RequestInit) =>
                  handler(new Request(input, init), Context.empty()),
                { preconnect: () => {} },
              ),
            ),
          ),
        ),
      ),
    ),
  );

export const TestHttpClientLive = makeTestHttpClientLive();