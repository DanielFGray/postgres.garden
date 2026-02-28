import { WebSdk } from "@effect/opentelemetry";
import { DevTools } from "@effect/experimental";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Layer } from "effect";

const collectorUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL;
const isDev = import.meta.env.DEV;

// Auto-instrumentations registered globally (hook the global TracerProvider set by WebSdk)
registerInstrumentations({
	instrumentations: [
		new FetchInstrumentation({
			propagateTraceHeaderCorsUrls: [window.location.origin],
		}),
		new DocumentLoadInstrumentation(),
		new UserInteractionInstrumentation(),
	],
});

const WebSdkLive = collectorUrl
	? WebSdk.layer(() => ({
			resource: { serviceName: "postgres-garden-web" },
			spanProcessor: new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: `${collectorUrl}/v1/traces`,
					// Force fetch transport instead of sendBeacon — sendBeacon can't
					// do CORS preflights, which breaks cross-origin JSON POSTs.
					headers: {},
				}),
			),
		}))
	: WebSdk.layer(() => ({
			resource: { serviceName: "postgres-garden-web" },
		}));

// DevTools.layer() includes Socket.layerWebSocketConstructorGlobal
// which uses the browser's native WebSocket — no platform-browser import needed
const DevToolsLive = isDev ? DevTools.layer() : Layer.empty;

export const TelemetryLive = Layer.provideMerge(WebSdkLive, DevToolsLive);
