import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import { HttpApiLive } from "../apiHandlers.js";
import { DatabaseLive } from "../db.js";
import { TestingRoutesLive } from "../testing.js";

/** The origin the in-process client sends requests to. Nothing listens on it. */
export const origin = "http://localhost";

/**
 * An HttpClient served by the app in this process, with no TCP listener: the
 * HttpApi and the `/api/testing` routes, as the dev server serves them.
 *
 * `overrides` is built under the app, so a test can replace a service the app
 * reads while it builds, such as the ConfigProvider.
 */
export const makeTestHttpClientLive = (overrides: Layer.Layer<never> = Layer.empty) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          Layer.mergeAll(HttpApiLive, TestingRoutesLive).pipe(
            Layer.provide(HttpServer.layerServices),
            Layer.provide(DatabaseLive),
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
