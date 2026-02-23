import { NodeSdk } from "@effect/opentelemetry";
import { DevTools } from "@effect/experimental";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { Layer } from "effect";
import { env } from "./assertEnv.js";

const isDev = env.NODE_ENV !== "production";
const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;

// Register auto-instrumentations globally (hooks into pg, ioredis, undici)
// These attach to whatever TracerProvider is registered globally by NodeSdk
registerInstrumentations({
	instrumentations: [
		new PgInstrumentation(),
		new IORedisInstrumentation(),
		new UndiciInstrumentation(),
	],
});

const NodeSdkLive = NodeSdk.layer(() => ({
	resource: { serviceName: "postgres-garden" },
	spanProcessor: otlpEndpoint
		? new BatchSpanProcessor(new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }))
		: undefined,
	metricReader: otlpEndpoint
		? new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
				exportIntervalMillis: 60_000,
			})
		: undefined,
	logRecordProcessor: otlpEndpoint
		? new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` }))
		: undefined,
}));

// DevTools layer connects via WebSocket to effect-devtui (port 34437)
// Must be provided BEFORE NodeSdkLive so it can patch the tracer
const DevToolsLive = isDev ? DevTools.layer() : Layer.empty;

export const TelemetryLive = Layer.provideMerge(NodeSdkLive, DevToolsLive);
