import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiLive } from "./apiHandlers.js";
import { isProduction } from "./config.js";

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
