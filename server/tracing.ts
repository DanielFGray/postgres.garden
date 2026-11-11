import { Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";

import packageJson from "../package.json" with { type: "json" };

/**
 * Exports the logs, spans and metrics that Effect creates to an OTLP collector.
 * Export is opt-in: `Otlp.layerFromConfig` reads OTEL_EXPORTER_OTLP_ENDPOINT
 * and OTEL_{TRACES,LOGS,METRICS}_EXPORTER, and enables a signal only when its
 * exporter is "otlp". With no exporter set, nothing is sent.
 */
export const TracingLayer = Otlp.layerFromConfig({
  resource: { serviceName: packageJson.name, serviceVersion: packageJson.version },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));
