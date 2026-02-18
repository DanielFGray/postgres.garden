import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { env } from "./assertEnv.js";

const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({
    "service.name": "postgres-garden",
  }),
  readers: env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
          }),
          exportIntervalMillis: 60_000,
        }),
      ]
    : [],
});

const meter = meterProvider.getMeter("postgres-garden");

export const authAttempts = meter.createCounter("auth.attempts", {
  description: "Number of authentication attempts",
});

export const authActiveSessions = meter.createUpDownCounter(
  "auth.active_sessions",
  { description: "Number of active sessions" },
);

export const webhookReceived = meter.createCounter("webhook.received", {
  description: "Number of webhooks received",
});
