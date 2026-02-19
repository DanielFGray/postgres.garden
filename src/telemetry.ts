import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";

const collectorUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL;

if (collectorUrl) {
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "postgres-garden-web",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${collectorUrl}/v1/traces` })),
    ],
  });

  provider.register();

  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: [window.location.origin],
      }),
      new DocumentLoadInstrumentation(),
      new UserInteractionInstrumentation(),
    ],
  });
}
