import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Ref } from "effect";
import { Redis, RedisError, make as makeRedis } from "effect/persistence/Redis";
import { TestClock } from "effect/testing";

import { PgRootDB } from "./db.js";
import { ValkeyReady } from "./dependencies.js";

/** A Redis whose every PING fails, as Valkey's does while it is down. */
const redisDown = (pings: Ref.Ref<number>) =>
  Layer.effect(
    Redis,
    makeRedis({
      send: () =>
        Ref.update(pings, (n) => n + 1).pipe(
          Effect.andThen(Effect.fail(new RedisError({ cause: "connection refused" }))),
        ),
      subscribe: () => Effect.die("not used"),
      connect: Effect.die("not used"),
    }),
  );

it.effect("fails with DependencyUnavailable after retrying a Valkey that never answers", () =>
  Effect.gen(function* () {
    const pings = yield* Ref.make(0);
    const wait = yield* Layer.build(ValkeyReady.pipe(Layer.provide(redisDown(pings)))).pipe(
      Effect.scoped,
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 minutes");
    const error = yield* Fiber.join(wait);
    expect(error._tag).toBe("DependencyUnavailable");
    expect(error.dependency).toBe("valkey");
    expect(yield* Ref.get(pings)).toBe(21);
  }),
);

it.effect("a Postgres pool fails with DependencyUnavailable when Postgres never answers", () =>
  Effect.gen(function* () {
    const wait = yield* Layer.build(PgRootDB.layer).pipe(
      Effect.scoped,
      Effect.flip,
      // Port 1 refuses every connection at once.
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }),
        ),
      ),
      Effect.forkChild,
    );
    // Each attempt is a real connection, and each wait between attempts is on
    // the test clock: step the clock, and give each attempt real time to fail.
    yield* TestClock.adjust("5 seconds").pipe(
      Effect.andThen(TestClock.withLive(Effect.sleep("20 millis"))),
      Effect.repeat({ until: () => wait.pollUnsafe() !== undefined, times: 200 }),
    );
    const error = yield* Fiber.join(wait);
    expect(error._tag).toBe("DependencyUnavailable");
    expect(error.message).toBe("postgres (DATABASE_URL) did not answer");
  }),
);
