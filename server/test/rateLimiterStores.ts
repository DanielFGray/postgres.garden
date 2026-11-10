import { Effect, Layer } from "effect";
import {
  RateLimiterError,
  RateLimiterStore,
  RateLimitStoreError,
} from "effect/persistence/RateLimiter";

import { rateLimiterWithStore } from "../services/rateLimiter.js";

/**
 * `RateLimiter`s whose store is down, for the policy each caller applies then:
 * one fails every call, as Valkey does when it refuses a command; one never
 * answers, as a client does while it queues commands during a reconnect.
 */
export const RateLimiterStoreFails = withStoreAnswer(
  Effect.fail(
    new RateLimiterError({
      reason: new RateLimitStoreError({ message: "Valkey is down" }),
    }),
  ),
);

export const RateLimiterStoreSilent = withStoreAnswer(Effect.never);

function withStoreAnswer(answer: Effect.Effect<never, RateLimiterError>) {
  return rateLimiterWithStore(
    Layer.succeed(
      RateLimiterStore,
      RateLimiterStore.of({
        fixedWindow: () => answer,
        tokenBucket: () => answer,
        adaptiveConsume: () => answer,
        adaptiveFeedback: () => answer,
      }),
    ),
  );
}
