import { Config, Duration, Layer } from "effect";
import {
  layerStoreMemory,
  layerStoreRedisConfig,
  make,
  RateLimiter,
  type RateLimiterStore,
} from "effect/persistence/RateLimiter";

/**
 * The `RateLimiter` that the API middleware counts against. Counts live in
 * Valkey, so a limit holds across processes and restarts.
 *
 * It requires Effect's `Redis` service (`effect/persistence/Redis`), which is
 * the Valkey client the server entry provides.
 *
 * Keys start with `VALKEY_KEY_PREFIX` and then `rl:`. The platform sets the
 * prefix to `<cartridge name>:`, the only keys the app's Valkey user may touch.
 */
export const RateLimiterValkey = rateLimiterWithStore(
  layerStoreRedisConfig({ prefix: rateLimitKeyPrefix() }),
);

/** Counts in process memory, for tests that must run without a Valkey. */
export const RateLimiterMemory = rateLimiterWithStore(layerStoreMemory);

/**
 * The longest a caller waits for the store. A Valkey client that queues
 * commands while it reconnects would otherwise stall each caller, instead of
 * letting it apply its own policy for a store that is down.
 */
export const storeTimeout = Duration.seconds(1);

/** The start of every rate-limit key in Valkey. */
export function rateLimitKeyPrefix() {
  return Config.String("VALKEY_KEY_PREFIX").pipe(Config.map((prefix) => `${prefix}rl:`));
}

/**
 * A `RateLimiter` over `store`. Each call makes a new Layer: a build memoizes
 * layers by reference, so two limiters made from Effect's one shared `layer`
 * would both get the store of whichever was built first.
 */
export function rateLimiterWithStore<E, R>(store: Layer.Layer<RateLimiterStore, E, R>) {
  return Layer.effect(RateLimiter, make).pipe(Layer.provide(store));
}
