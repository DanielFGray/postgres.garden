import { Effect, Layer } from "effect";
import { DevTools } from "effect/devtools";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";

import packageJson from "../package.json" with { type: "json" };
import { isProduction } from "./config.js";

/**
 * Exports the logs, spans and metrics that Effect creates to an OTLP collector.
 * Each signal exports only when the collector is set
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`) and that signal's exporter list names otlp:
 * `OTEL_TRACES_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`,
 * `OTEL_METRICS_EXPORTER=otlp`. The endpoint alone exports nothing.
 */
const OtlpLive = Otlp.layerFromConfig({
  resource: { serviceName: packageJson.name, serviceVersion: packageJson.version },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

/** Outside production the Effect DevTools also receive every span. */
const DevToolsLive = Layer.unwrap(
  isProduction.pipe(Effect.map((production) => (production ? Layer.empty : DevTools.layer()))),
);

/**
 * The tracer for the whole process: OTLP export, and outside production the
 * DevTools too. The DevTools tracer wraps the tracer current where it is
 * built and replaces it, so it is built on the OTLP layer. Built beside it,
 * it would wrap the native tracer, and one of the two would get no spans.
 */
export const TracingLayer = DevToolsLive.pipe(Layer.provideMerge(OtlpLive));
