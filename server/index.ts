#!/usr/bin/env bun

import { BunHttpServer, BunRedis, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { DatabaseLive } from "./db.js";
import { Pages, PagesRoutesLive, PagesUntraced } from "./pages.js";
import { PageData } from "./services/pageData.js";
import { RateLimitMiddlewareLive } from "./rateLimit.js";
import { waitForDependencies } from "./ready.js";
import { ApiRoutesLive } from "./runtime.js";
import { RateLimiterValkey } from "./services/rateLimiter.js";
import { SessionService } from "./services/sessionService.js";
import { TelemetryLive } from "./telemetry.js";
import { WorkerLive } from "./worker.js";

const ListenerLive = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.Port("PORT");
    const hostname = yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0"));
    return BunHttpServer.layer({
      port,
      hostname,
      // Bun would otherwise read 128MB before anything judged the request.
      // The largest body any route takes is a workspace save, and 64MB is far
      // above a workspace of text while a save with no account is capped at
      // 1MB. This is not a storage rule: what a writer may store is
      // app_public.max_storage_bytes, which refuses from a smaller number per
      // role. This only stops the server reading a body nothing can accept.
      maxRequestBodySize: 64 * 1024 * 1024,
    });
  }),
);

/**
 * Everything the routes use, built before the server listens. Nothing is
 * served until Postgres and Valkey answer: a container that comes up beside
 * its database would otherwise spend its first seconds answering 500 to real
 * traffic, and the platform's health check would pass throughout.
 */
const ServicesLive = Layer.mergeAll(
  Pages.layer.pipe(Layer.provide(PageData.layer)),
  TelemetryLive,
  PagesUntraced,
  RateLimitMiddlewareLive.pipe(Layer.provide(RateLimiterValkey)),
  Layer.effectDiscard(waitForDependencies),
).pipe(
  Layer.provideMerge(SessionService.layer.pipe(Layer.provideMerge(DatabaseLive))),
  // Bun's client connects on first use, so a Valkey that is down does not fail
  // this layer; the dependency wait above keeps the port closed until it answers.
  // By default the client stops after a few reconnect attempts and stays closed
  // when Valkey returns, and it holds commands while it reconnects. With these
  // options it keeps reconnecting, and a command fails at once while Valkey is
  // down, so a page or a session read does not wait on the outage.
  Layer.provideMerge(
    BunRedis.layerConfig({
      url: Config.String("VALKEY_URL"),
      maxRetries: Config.succeed(1_000_000),
      enableOfflineQueue: Config.succeed(false),
    }),
  ),
  Layer.provideMerge(BunServices.layer),
);

// Layer.provide builds the provided layer first and releases it last, so the
// services come up before the listener, and the worker starts after the
// server listens and stops before the database pools close.
const ServerLive = HttpRouter.serve(Layer.mergeAll(ApiRoutesLive, PagesRoutesLive)).pipe(
  Layer.provide(ListenerLive),
  Layer.provide(ServicesLive),
);

BunRuntime.runMain(Layer.launch(WorkerLive.pipe(Layer.provide(ServerLive))));
