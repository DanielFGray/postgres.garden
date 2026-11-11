import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../shared/httpApi.js";
import { AuthApiGroupLive } from "./api/auth.js";
import { PlaygroundsApiGroupLive } from "./api/playgrounds.js";
import { SystemApiGroupLive } from "./api/system.js";
import { UsersApiGroupLive } from "./api/users.js";
import { WebhooksApiGroupLive } from "./api/webhooks.js";
import { isProduction } from "./config.js";
import { FailureBoundaryLive } from "./failureBoundary.js";
import { DatabaseLive } from "./db.js";
import { Pages, PagesRoutesLive, PagesUntraced } from "./pages.js";
import { RateLimitMiddlewareLive } from "./rateLimit.js";
import { Readiness } from "./ready.js";
import { RateLimiterValkey } from "./services/rateLimiter.js";
import { AuthService } from "./services/authService.js";
import { OAuthPopup } from "./services/oauthPopup.js";
import { PageData } from "./services/pageData.js";
import { PlaygroundService } from "./services/playgroundService.js";
import { SessionMiddlewareLive } from "./services/sessionMiddleware.js";
import { SessionService } from "./services/sessionService.js";
import { UserService } from "./services/userService.js";
import { WebhookService } from "./services/webhookService.js";
import { TracingLayer } from "./tracing.js";
import { Worker } from "../worker/worker.js";

/**
 * The routes the server and the API tests share: the HttpApi, the testing
 * routes outside production, and the headers on every response. ServerLive
 * adds the browser app and the listener.
 */
export const ApiRoutesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (yield* isProduction) return Layer.mergeAll(HttpApiLive, responseHeadersLive);
    // Loaded with import() so production never loads the testing routes; their
    // service also refuses to build in production.
    const { TestingRoutesLive } = yield* Effect.promise(() => import("./testing.js"));
    return Layer.mergeAll(HttpApiLive, TestingRoutesLive, responseHeadersLive);
  }),
);

const HttpApiHandlers = HttpApiBuilder.layer(PgGardenApi).pipe(
  Layer.provide(AuthApiGroupLive),
  Layer.provide(UsersApiGroupLive),
  Layer.provide(PlaygroundsApiGroupLive),
  Layer.provide(WebhooksApiGroupLive),
  Layer.provide(SystemApiGroupLive),
);

/**
 * The services the routes and pages use, with the database pools they share.
 * ServerLive and the API tests provide it once. Each service layer
 * provides its own dependencies, and Layer memoizes by reference, so a service
 * that several layers name (SessionService, Cookies) is built once.
 */
export const AppLayer = Layer.mergeAll(
  AuthService.layer,
  UserService.layer,
  PlaygroundService.layer,
  OAuthPopup.layer,
  WebhookService.layer,
  PageData.layer,
  SessionService.layer,
).pipe(Layer.provideMerge(DatabaseLive));

const HttpApiLive = HttpApiHandlers.pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provide(FailureBoundaryLive),
);

/**
 * The workbench runs cross-origin isolated, so every response carries COOP and
 * COEP. CORP lets the pages embed what the server sends.
 */
const responseHeadersLive = HttpRouter.middleware(
  (effect) =>
    Effect.map(
      effect,
      HttpServerResponse.setHeaders({
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "cross-origin",
      }),
    ),
  { global: true },
);

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
  Pages.layer,
  TracingLayer,
  PagesUntraced,
  RateLimitMiddlewareLive,
  // Layer.provide builds the wait first, so the runner starts only once
  // Postgres answers; it starts in the background, so the listener does not
  // wait for graphile-worker's migrations.
  Worker.layer.pipe(Layer.provide(Layer.effectDiscard(Readiness.use((r) => r.waitUntilReady)))),
).pipe(
  // The API middleware and the worker count against one limiter.
  Layer.provide(RateLimiterValkey),
  Layer.provideMerge(Readiness.layer),
  Layer.provideMerge(AppLayer),
);

/**
 * The server process: the API, the testing routes outside production, the
 * browser app, and the graphile-worker runner. Layer.provide builds the
 * provided layer first and releases it last, so the services come up before
 * the listener opens, and the worker stops before the database pools close.
 * The entry point provides the Valkey client and the platform services.
 */
export const ServerLive = HttpRouter.serve(Layer.mergeAll(ApiRoutesLive, PagesRoutesLive)).pipe(
  Layer.provide(ListenerLive),
  Layer.provide(ServicesLive),
);
