import { expect, it, suite } from "@effect/vitest";
import { type Config, ConfigProvider, Effect, Layer, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { Redis, RedisError, make as makeRedis } from "effect/persistence/Redis";

import { Worker } from "../worker/worker.js";
import { PgAuthDB, PgRootDB, toDatabaseError } from "./db.js";
import type { DependencyUnavailable } from "./dependencies.js";
import { HealthLive } from "./health.js";
import { TestValkeyLive } from "./test/valkey.js";
import { requestProbe } from "./test/probeServer.js";

const workerRunning = (isRunning: boolean) =>
  Layer.succeed(Worker, Worker.of({ isRunning: Effect.succeed(isRunning) }));

/** The real auth pool, except that every query fails. */
const AuthDatabaseDown = Layer.effect(
  PgAuthDB,
  Effect.gen(function* () {
    const handle = yield* PgAuthDB;
    return PgAuthDB.of({
      ...handle,
      all: () => Effect.fail(toDatabaseError(new Error("connection refused"))),
    });
  }),
).pipe(Layer.provide(PgAuthDB.layer));

/** A Valkey whose every command fails, as it does while Valkey is down. */
const ValkeyDown = Layer.effect(
  Redis,
  makeRedis({
    send: () => Effect.fail(new RedisError({ cause: "connection refused" })),
    subscribe: () => Effect.die("not used"),
    connect: Effect.die("not used"),
  }),
);

/** The /healthz body, as the platform health contract reads it. */
const HealthBody = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["ok", "error"]),
    commit: Schema.String,
    failed: Schema.optionalKey(Schema.Array(Schema.Literals(["database", "valkey", "worker"]))),
  }),
);

const getHealth = Effect.fn(function* ({
  worker,
  authDatabase = PgAuthDB.layer,
  valkey = TestValkeyLive,
}: {
  readonly worker: Layer.Layer<Worker>;
  readonly authDatabase?: Layer.Layer<PgAuthDB, Config.ConfigError | DependencyUnavailable>;
  readonly valkey?: Layer.Layer<Redis, Config.ConfigError | RedisError>;
}) {
  const { status, body, lines, spans } = yield* requestProbe(
    HealthLive.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ GIT_COMMIT: "abc123" }))),
      Layer.provide(Layer.mergeAll(worker, PgRootDB.layer, authDatabase, valkey)),
    ),
    HttpClientRequest.get("/healthz"),
  );
  return {
    status,
    body: yield* Schema.decodeEffect(HealthBody)(body),
    lines,
    spans: spans.map(({ name }) => name),
  };
});

suite("/healthz", () => {
  it.live(
    "answers 200 with the commit, and logs and traces nothing, when every dependency answers",
    () =>
      Effect.gen(function* () {
        expect(yield* getHealth({ worker: workerRunning(true) })).toEqual({
          status: 200,
          body: { status: "ok", commit: "abc123" },
          lines: [],
          spans: [],
        });
      }),
  );

  it.live("answers 503 naming every failed dependency, and logs each cause and the response", () =>
    Effect.gen(function* () {
      const { status, body, lines, spans } = yield* getHealth({
        worker: workerRunning(false),
        authDatabase: AuthDatabaseDown,
        valkey: ValkeyDown,
      });
      expect({ status, body }).toEqual({
        status: 503,
        body: { status: "error", commit: "abc123", failed: ["database", "valkey", "worker"] },
      });
      // The probes run concurrently, so their Error lines come in either order.
      const [first, second, response] = lines.map(({ level, message }) => [level, message]);
      expect([first, second]).toEqual(
        expect.arrayContaining([
          [
            "Error",
            [
              "Health check: database unavailable",
              expect.objectContaining({ _tag: "DatabaseError" }),
            ],
          ],
          [
            "Error",
            ["Health check: valkey unavailable", expect.objectContaining({ _tag: "RedisError" })],
          ],
        ]),
      );
      expect(response).toEqual(["Info", ["Sent HTTP response"]]);
      expect(lines).toHaveLength(3);
      expect(spans).toEqual([]);
    }),
  );
});
