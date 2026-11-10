import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";
import { registerInstrumentations } from "@opentelemetry/instrumentation";

const collectorUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL;

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

export const TelemetryLive = collectorUrl
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
