import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Redis } from "effect/persistence/Redis";
import { PgGardenApi } from "../shared/httpApi.js";
import { AuthApiGroupLive } from "./api/auth.js";
import { PlaygroundsApiGroupLive } from "./api/playgrounds.js";
import { SystemApiGroupLive } from "./api/system.js";
import { UsersApiGroupLive } from "./api/users.js";
import { WebhooksApiGroupLive } from "./api/webhooks.js";
import { isProduction } from "./config.js";
import { DatabaseLive } from "./db.js";
import { AuthService } from "./services/authService.js";
import { Cookies } from "./services/cookies.js";
import { OAuthPopup } from "./services/oauthPopup.js";
import { OAuthService } from "./services/oauthService.js";
import { PlaygroundService } from "./services/playgroundService.js";
import { SessionMiddlewareLive } from "./services/sessionMiddleware.js";
import { SessionService } from "./services/sessionService.js";
import { UserService } from "./services/userService.js";
import { WebhookService } from "./services/webhookService.js";

/**
 * The routes the server and the API tests share: the HttpApi, the testing
 * routes outside production, and the headers on every response. The server
 * entry adds the browser app and the listener.
 */
export const ApiRoutesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (yield* isProduction) return Layer.mergeAll(HttpApiLive, responseHeadersLive);
    // Loaded with import() so production never loads the testing routes; they
    // also refuse requests in production.
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

// One layer value, used twice: `Layer.provide` satisfies the plain requirements of
// the middleware and handlers, and `HttpRouter.provideRequest` satisfies the
// request-scoped `Requires` markers, which `Layer.provide` leaves unsatisfied.
// Layer memoization builds each service and pool once.
const RequestServices = Layer.mergeAll(
  Cookies.layer,
  AuthService.layer,
  UserService.layer,
  PlaygroundService.layer,
  SessionService.layer,
  OAuthService.layer,
  OAuthPopup.layer.pipe(Layer.provide(Layer.mergeAll(OAuthService.layer, Cookies.layer))),
  WebhookService.layer,
  // The health check pings Valkey inside a handler, so the server's one client
  // is lifted from the layer context into the request context.
  Layer.effect(Redis, Redis.use(Effect.succeed)),
).pipe(Layer.provideMerge(DatabaseLive));

const HttpApiLive = HttpApiHandlers.pipe(
  Layer.provide(SessionMiddlewareLive),
  Layer.provide(RequestServices),
  HttpRouter.provideRequest(RequestServices),
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
