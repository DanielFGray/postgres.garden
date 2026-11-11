import { BunHttpServer } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { PgGardenApi } from "../shared/httpApi.js";
import { AuthApiGroupLive } from "./api/auth.js";
import { PlaygroundsApiGroupLive } from "./api/playgrounds.js";
import { UsersApiGroupLive } from "./api/users.js";
import { WebhooksApiGroupLive } from "./api/webhooks.js";
import { isProduction } from "./config.js";
import { FailureBoundaryLive } from "./failureBoundary.js";
import { DatabaseLive } from "./db.js";
import { ValkeyReady } from "./dependencies.js";
import { HealthLive } from "./health.js";
import { Pages, PagesRoutesLive, PagesUntraced } from "./pages.js";
import { RateLimitMiddlewareLive } from "./rateLimit.js";
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
import { MailCapture, Mailer } from "../worker/email/mailer.js";
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
);

/**
 * The services the routes, pages and worker use, with the database pools they
 * share. The worker sends through the Mailer, and the testing routes read the
 * mail it captures, so both live here: a mail provider that cannot start
 * stops the server.
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
  Mailer.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, MailCapture.layer)));

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
 * Everything the routes use, built before the server listens.
 *
 * Layer.provide builds the provided layer first, so the build runs from the
 * bottom of the pipe up: the tracer, then the wait for the hard dependencies
 * (both Postgres pools and Valkey, together; server/dependencies.ts), then the
 * services and the worker. Until every dependency answers, the port stays
 * closed and no job runs. The worker starts its runner in the background, so
 * the listener does not wait for graphile-worker's migrations.
 */
const ServicesLive = Layer.mergeAll(Pages.layer, RateLimitMiddlewareLive, Worker.layer).pipe(
  // The API middleware and the worker count against one limiter.
  Layer.provide(RateLimiterValkey),
  Layer.provideMerge(AppLayer),
  // A build makes each layer once, so AppLayer reuses these pools.
  Layer.provide(Layer.mergeAll(ValkeyReady, DatabaseLive)),
  // HttpServer.serve runs each request in the context its layer is built in,
  // not in the served layer's outputs. So the exporter and the rule that
  // skips page and health spans reach `ServerLive` through these outputs, and
  // the request's server span and everything under it use them, as do the
  // worker and the wait.
  Layer.provideMerge(Layer.mergeAll(TracingLayer, PagesUntraced)),
);

/**
 * The server process: the API, the testing routes outside production, the
 * browser app, and the graphile-worker runner. Layer.provide builds the
 * provided layer first and releases it last, so the services come up before
 * the listener opens, and the worker stops before the database pools close.
 * The entry point provides the Valkey client and the platform services.
 */
export const ServerLive = HttpRouter.serve(
  Layer.mergeAll(ApiRoutesLive, PagesRoutesLive, HealthLive),
).pipe(Layer.provide(ListenerLive), Layer.provide(ServicesLive));
