/**
 * Server metric instruments. Each `record*` function returns an Effect that
 * adds one sample. `tracing.ts` decides whether the samples are exported.
 */
import { Metric } from "effect";

const authAttempts = Metric.counter("auth.attempts", {
  description: "Number of authentication attempts",
});

const authActiveSessions = Metric.counter("auth.active_sessions", {
  description: "Number of active sessions",
});

const webhookReceived = Metric.counter("webhook.received", {
  description: "Number of webhooks received",
});

export const recordAuthAttempt = (attributes: {
  readonly method: string;
  readonly action: string;
  readonly result: string;
}) => Metric.update(Metric.withAttributes(authAttempts, attributes), 1);

/** Adds `delta` to the live session count: +1 when a session starts, -1 when it ends. */
export const recordActiveSessions = (delta: number) => Metric.update(authActiveSessions, delta);

export const recordWebhook = (attributes: {
  readonly provider: string;
  readonly event: string;
  readonly verified: string;
}) => Metric.update(Metric.withAttributes(webhookReceived, attributes), 1);
