import { Layer } from "effect";
import { DevTools } from "effect/devtools";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Otlp from "effect/observability/Otlp";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import { env } from "./assertEnv.js";

const isDev = env.NODE_ENV !== "production";

// Export is opt-in. `Otlp.layerFromConfig` reads OTEL_EXPORTER_OTLP_ENDPOINT and
// OTEL_{TRACES,LOGS,METRICS}_EXPORTER, and enables a signal only when its
// exporter is "otlp". With no exporter set, nothing is sent.
const OtlpLive = Otlp.layerFromConfig({
  resource: { serviceName: "postgres-garden" },
}).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer));

// DevTools connects to effect-devtui over WebSocket (port 34437).
const DevToolsLive = isDev ? DevTools.layer() : Layer.empty;

export const TelemetryLive = Layer.provideMerge(OtlpLive, DevToolsLive);
