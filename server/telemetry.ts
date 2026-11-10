import { Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";

// Export is opt-in. `Otlp.layerFromConfig` reads OTEL_EXPORTER_OTLP_ENDPOINT and
// OTEL_{TRACES,LOGS,METRICS}_EXPORTER, and enables a signal only when its
// exporter is "otlp". With no exporter set, nothing is sent.
export const TelemetryLive = Otlp.layerFromConfig({
  resource: { serviceName: "postgres-garden" },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));
