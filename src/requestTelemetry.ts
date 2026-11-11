/**
 * Observability for one server call started by a UI action.
 *
 * The trace context is not here: `HttpClient` writes `traceparent` from the
 * live span when it sends the request, which would overwrite anything set
 * earlier, and the trace id is what joins a call to the server's spans.
 */
export type RequestTelemetry = {
  readonly action: string;
  readonly feature: string;
};

/** Headers that carry one call's telemetry to the server. */
export const telemetryHeaders = (telemetry: RequestTelemetry) => ({
  "x-ui-action": telemetry.action,
  "x-ui-feature": telemetry.feature,
});
