import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { DevTools } from "effect/devtools";
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

// Streaming traces to effect-devtui is opt-in, like the OTLP export above:
// the devtools client retries its WebSocket every second and never gives up,
// so switching it on by NODE_ENV alone fills the console of every dev who is
// not running the collector. DevTools.layer() provides the global WebSocket
// constructor itself, so no platform-browser import is needed.
const devtoolsUrl = import.meta.env.VITE_DEVTOOLS_URL;
const DevToolsLive = isDev && devtoolsUrl ? DevTools.layer(devtoolsUrl) : Layer.empty;

export const TelemetryLive = Layer.provideMerge(WebSdkLive, DevToolsLive);
