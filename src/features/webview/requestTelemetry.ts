export type RequestTelemetryContext = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
  readonly requestId: string;
  readonly action?: string;
  readonly feature?: string;
};

const randomHex = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const createTraceparent = (): string => `00-${randomHex(16)}-${randomHex(8)}-01`;

export const createRequestTelemetryContext = (args: {
  readonly action?: string;
  readonly feature?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}): RequestTelemetryContext => ({
  requestId: randomHex(16),
  action: args.action,
  feature: args.feature,
  traceparent: args.traceparent ?? createTraceparent(),
  tracestate: args.tracestate,
  baggage: args.baggage,
});

export const applyTelemetryHeaders = (
  headers: Record<string, string>,
  telemetry?: RequestTelemetryContext,
): void => {
  if (!telemetry) {
    return;
  }

  headers["x-request-id"] = telemetry.requestId;
  if (telemetry.action) {
    headers["x-ui-action"] = telemetry.action;
  }
  if (telemetry.feature) {
    headers["x-ui-feature"] = telemetry.feature;
  }
  if (telemetry.traceparent) {
    headers.traceparent = telemetry.traceparent;
  }
  if (telemetry.tracestate) {
    headers.tracestate = telemetry.tracestate;
  }
  if (telemetry.baggage) {
    headers.baggage = telemetry.baggage;
  }
};
