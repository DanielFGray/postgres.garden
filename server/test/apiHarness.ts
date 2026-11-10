import { type Config, Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { RateLimiter } from "effect/persistence/RateLimiter";

import type { RateLimitMiddleware } from "../../shared/api/rateLimit.js";
import { DatabaseLive } from "../db.js";
import { RateLimitMiddlewarePassThrough } from "../rateLimit.js";
import { ApiRoutesLive } from "../runtime.js";
import { RateLimiterMemory } from "../services/rateLimiter.js";
import { TestValkeyLive } from "./valkey.js";

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
 */
export const makeTestHttpClientLive = (
  overrides: Layer.Layer<never> = Layer.empty,
  rateLimit: Layer.Layer<
    RateLimitMiddleware,
    Config.ConfigError,
    RateLimiter
  > = RateLimitMiddlewarePassThrough,
) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ApiRoutesLive.pipe(
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
