import { Cause, Context, Effect, Layer, Logger, References } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

/** One line the probe server logged. */
export type LogLine = {
  readonly level: string;
  readonly message: unknown;
  readonly cause: string;
  readonly traceId: unknown;
};

/**
 * Serves `app` in process for one request, and returns the response with every
 * line logged while it was answered.
 */
export const requestProbe = <E>(
  app: Layer.Layer<
    never,
    E,
    HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
  >,
  path: string,
  init?: RequestInit,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const lines: Array<LogLine> = [];
      const recordLines = Logger.layer([
        Logger.make((options) => {
          lines.push({
            level: options.logLevel,
            message: options.message,
            cause: Cause.pretty(options.cause),
            traceId: options.fiber.getRef(References.CurrentLogAnnotations).traceId,
          });
        }),
      ]);
      const web = HttpRouter.toWebHandler(
        app.pipe(Layer.provide(recordLines), Layer.provide(HttpServer.layerServices)),
        { disableLogger: true },
      );
      return { web, lines };
    }),
    ({ web }) => Effect.promise(() => web.dispose()),
  ).pipe(
    Effect.flatMap(({ web, lines }) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          web.handler(new Request(`http://localhost${path}`, init), Context.empty()),
        );
        const body = yield* Effect.promise(() => response.text());
        return { status: response.status, body, lines };
      }),
    ),
    Effect.scoped,
  );
