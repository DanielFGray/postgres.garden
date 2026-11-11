// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes a node:http server factory
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { type Config, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import type { RateLimiter } from "effect/persistence/RateLimiter";
import type { Redis } from "effect/persistence/Redis";

import type { RateLimitMiddleware } from "../../shared/api/rateLimit.js";
import { DatabaseLive } from "../db.js";
import { RateLimitMiddlewarePassThrough } from "../rateLimit.js";
import { ApiRoutesLive, AppLayer } from "../runtime.js";
import { Readiness } from "../ready.js";
import { RateLimiterMemory } from "../services/rateLimiter.js";
import { Worker } from "../../worker/worker.js";
import { TestValkeyLive } from "./valkey.js";

/**
 * The HttpApi and the `/api/testing` routes, as the dev server serves them, on
 * `TestServer`, with an `HttpClient` aimed at them: requests take a path, such
 * as `/api/me`. The layer also provides the app's services and the Valkey
 * client, so a test reads the database through the same `PgRootDB` pool the
 * API uses.
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
export const makeTestApi = ({
  overrides = Layer.empty,
  rateLimit = RateLimitMiddlewarePassThrough,
  health = Layer.mergeAll(Readiness.layer, workerRunning),
}: {
  readonly overrides?: Layer.Layer<never>;
  readonly rateLimit?: Layer.Layer<RateLimitMiddleware, Config.ConfigError, RateLimiter>;
  readonly health?: HealthDependencies;
} = {}) =>
  // Route handlers take their services per request, so the served layer gets
  // them too, as `ServerLive` does.
  HttpRouter.serve(ApiRoutesLive, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(health),
    Layer.provide(rateLimit),
    Layer.provide(RateLimiterMemory),
    Layer.provideMerge(AppLayer),
    Layer.provideMerge(TestValkeyLive),
    Layer.provideMerge(overrides),
    // TestServer also gives the file system the ethereal Mailer reads.
    Layer.provideMerge(TestServer),
  );

/**
 * A server on a free port of 127.0.0.1, and an `HttpClient` aimed at it.
 * `NodeHttpServer.layerTest` listens on every interface, and the testing API
 * it would serve can create users and sessions, so this one binds loopback
 * only.
 *
 * The client returns a redirect as it is: tests assert on the 302 itself and
 * read the cookies it sets, and following it would leave the test server (the
 * OAuth start redirects to GitHub).
 */
export const TestServer = HttpServer.layerTestClient.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false, redirect: "manual" }),
  ),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
);

/** A worker whose runner is up, for the health check. */
export const workerRunning = Layer.succeed(Worker, Worker.of({ check: Effect.void }));

/** What the health check reads: built over the database pools and Valkey. */
export type HealthDependencies = Layer.Layer<
  Readiness | Worker,
  never,
  Layer.Success<typeof DatabaseLive> | Redis
>;

/** The API with its defaults, for suites that need nothing replaced. Built
 * last: `makeTestApi` reads the values above. */
export const TestApi = makeTestApi();
