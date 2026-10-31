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

// Streaming traces to effect-devtui is opt-in, like the export above: the
// devtools client retries its WebSocket every second and never gives up, so
// switching it on by NODE_ENV alone means a dev who is not running the
// collector pays for a reconnect loop. Set VITE_DEVTOOLS_URL (the client reads
// the same variable) to something like ws://localhost:34437 to turn it on.
const DevToolsLive =
  isDev && env.VITE_DEVTOOLS_URL ? DevTools.layer(env.VITE_DEVTOOLS_URL) : Layer.empty;

export const TelemetryLive = Layer.provideMerge(OtlpLive, DevToolsLive);
