import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { env } from "./assertEnv.js";

if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "postgres-garden",
    }),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`,
        }),
      ),
    ],
  });

  logs.setGlobalLoggerProvider(loggerProvider);
}

const logger = logs.getLogger("postgres-garden");

type LogAttrs = Record<string, string | number | boolean>;

export function logInfo(message: string, attrs?: LogAttrs) {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: message,
    attributes: attrs,
  });
}

export function logWarn(message: string, attrs?: LogAttrs) {
  logger.emit({
    severityNumber: SeverityNumber.WARN,
    severityText: "WARN",
    body: message,
    attributes: attrs,
  });
}

export function logError(message: string, error?: unknown, attrs?: LogAttrs) {
  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: message,
    attributes: {
      ...attrs,
      ...(error instanceof Error
        ? { "exception.type": error.name, "exception.message": error.message }
        : error != null
          ? { "exception.message": JSON.stringify(error) }
          : {}),
    },
  });
}
