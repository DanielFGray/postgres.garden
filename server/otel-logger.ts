import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { env } from "./assertEnv.js";
import * as S from "effect/Schema";
import { Match } from "effect";

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
const LoggableError = S.Union(
  S.String,
  S.Struct({ name: S.optional(S.String), message: S.String }),
);

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

export function logError(message: string, cause?: unknown, attrs?: LogAttrs) {
  const parsed = cause === undefined ? undefined : S.decodeUnknownEither(LoggableError)(cause);
  const exception =
    parsed === undefined
      ? {}
      : Match.value(parsed).pipe(
          Match.tags({
            Left: () => ({ "exception.message": S.encodeSync(S.parseJson(S.Unknown))(cause) }),
            Right: ({ right }) =>
              typeof right === "string"
                ? { "exception.message": right }
                : { "exception.message": right.message },
          }),
          Match.exhaustive,
        );
  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    body: message,
    attributes: {
      ...attrs,
      ...exception,
    },
  });
}
