import { Cause, Context, Effect, Layer, Logger, References } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import { TestServer } from "./apiHarness.js";

/** One line the probe server logged. */
export type LogLine = {
  readonly level: string;
  readonly message: unknown;
  readonly cause: string;
  readonly traceId: unknown;
};

/**
 * Serves `app` for one request, and returns the response with every line
 * logged while it was answered. The server stops when the request is done.
 */
export const requestProbe = Effect.fn(function* <A, E, R>(
  app: Layer.Layer<A, E, R>,
  request: HttpClientRequest.HttpClientRequest,
) {
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
  const served = yield* Layer.build(
    HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(recordLines),
      Layer.provideMerge(TestServer),
    ),
  );
  const client = Context.get(served, HttpClient.HttpClient);
  const response = yield* client.execute(request);
  return { status: response.status, body: yield* response.text, lines };
}, Effect.scoped);
