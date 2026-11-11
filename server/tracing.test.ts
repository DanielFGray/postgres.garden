import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer, Ref, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { TestServer } from "./test/apiHarness.js";
import { TracingLayer } from "./tracing.js";

/** A collector that keeps the body of each trace export it receives. */
const collector = Effect.gen(function* () {
  const exports = yield* Ref.make<ReadonlyArray<string>>([]);
  const served = yield* Layer.build(
    HttpRouter.serve(
      HttpRouter.add(
        "POST",
        "/v1/traces",
        HttpServerRequest.HttpServerRequest.use((request) => request.text).pipe(
          Effect.flatMap((body) => Ref.update(exports, (all) => [...all, body])),
          Effect.as(HttpServerResponse.jsonUnsafe({})),
        ),
      ),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provideMerge(TestServer)),
  );
  const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(served));
  return { url, exports: Ref.get(exports) };
});

it.live.each(["development", "production"])(
  "exports a span to the OTLP collector when NODE_ENV is %s",
  (nodeEnv) =>
    Effect.gen(function* () {
      const { url, exports } = yield* collector;
      const scope = yield* Scope.make();
      const tracing = yield* Layer.buildWithScope(
        TracingLayer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NODE_ENV: nodeEnv,
                OTEL_TRACES_EXPORTER: "otlp",
                OTEL_EXPORTER_OTLP_ENDPOINT: url,
              }),
            ),
          ),
        ),
        scope,
      );
      yield* Effect.void.pipe(Effect.withSpan("tracing.test"), Effect.provide(tracing));
      // Closing the scope flushes the exporter.
      yield* Scope.close(scope, Exit.void);
      expect((yield* exports).join("\n")).toContain('"tracing.test"');
    }).pipe(Effect.scoped),
);
