import { Cause, Context, Effect, Layer, Logger, References, Tracer } from "effect";
import { HttpClient, type HttpClientRequest, HttpRouter } from "effect/http";

import { PagesUntraced } from "../pages.js";
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
 * logged and every span started while it was answered. It serves as the server
 * does (`ServerLive` in server/runtime.ts): the HTTP logger is on, and only API
 * paths are traced. The server stops when the request is done.
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
  const spans: Array<Tracer.Span> = [];
  const recordSpans = Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span(options) {
        const span = Tracer.nativeTracer.span(options);
        spans.push(span);
        return span;
      },
    }),
  );
  const served = yield* Layer.build(
    HttpRouter.serve(app, { disableListenLog: true }).pipe(
      Layer.provide(Layer.mergeAll(recordLines, recordSpans, PagesUntraced)),
      Layer.provideMerge(TestServer),
    ),
  );
  const client = Context.get(served, HttpClient.HttpClient);
  const response = yield* client.execute(request);
  return { status: response.status, body: yield* response.text, lines, spans };
}, Effect.scoped);
