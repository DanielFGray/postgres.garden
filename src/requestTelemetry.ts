import { Effect } from "effect";

/**
 * Observability for one server call started by a UI action.
 *
 * `server/apiHandlers.ts` reads these back off the request headers, so the span
 * the server records stays joined to the action that caused it. The trace
 * context itself is not here: `HttpClient` writes `traceparent` from the live
 * span when it sends the request, which would overwrite anything set earlier.
 */
export type RequestTelemetry = {
  readonly requestId: string;
  readonly action: string;
  readonly feature: string;
};

/** Headers that carry one call's telemetry to the server. */
export const telemetryHeaders = (telemetry: RequestTelemetry) => ({
  "x-request-id": telemetry.requestId,
  "x-ui-action": telemetry.action,
  "x-ui-feature": telemetry.feature,
});

export const makeRequestTelemetry = Effect.fnUntraced(function* (args: {
  readonly action: string;
  readonly feature: string;
}) {
  const requestId = yield* randomHex(16);
  return { requestId, action: args.action, feature: args.feature } satisfies RequestTelemetry;
});

const randomHex = (bytes: number) =>
  Effect.sync(() => {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
