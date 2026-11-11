import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema as S } from "effect";
import { SecureRandom } from "effect/crypto";
import { Redis } from "effect/persistence/Redis";
import { DatabaseLive, PgRootDB, type DbHandle } from "../db.js";
import { createUser, deleteUser, randomSuffix, withCapturedLogs } from "../testSupport.js";
import { TestValkeyLive } from "../test/valkey.js";
import { SessionService, sessionKeyOf } from "./sessionService.js";

const randomUuid = SecureRandom.SecureRandom.use((random) => random.uuidV4());

const sessionRows = (db: DbHandle, userId: string) =>
  db.all(
    db.connection.selectFrom("app_private.sessions").selectAll().where("user_id", "=", userId),
  );

const deleteSessionRow = (db: DbHandle, sessionUuid: string) =>
  db.all(db.connection.deleteFrom("app_private.sessions").where("id", "=", sessionUuid));

const Hash = S.Record(S.String, S.String);

const readKey = (key: string) =>
  Redis.use((redis) => redis.send("HGETALL", key)).pipe(
    Effect.flatMap(S.decodeUnknownEffect(Hash)),
    Effect.orDie,
  );

const readHash = Effect.fnUntraced(function* (cookieId: string) {
  const sessionKey = yield* sessionKeyOf;
  return yield* readKey(sessionKey(cookieId));
});

const writeHash = Effect.fnUntraced(function* (cookieId: string, fields: Record<string, string>) {
  const sessionKey = yield* sessionKeyOf;
  const redis = yield* Redis;
  yield* redis.send("HSET", sessionKey(cookieId), ...Object.entries(fields).flat());
}, Effect.orDie);

const dropHash = Effect.fnUntraced(function* (cookieId: string) {
  const sessionKey = yield* sessionKeyOf;
  const redis = yield* Redis;
  yield* redis.send("DEL", sessionKey(cookieId));
}, Effect.orDie);

/**
 * Every cached session that names `userId`. `createSession` chooses the cookie
 * id itself and does not report it when it fails, so the only way to see
 * whether a failed call left a hash behind is to look at all of them.
 */
const cachedSessionsFor = Effect.fnUntraced(function* (userId: string) {
  const sessionKey = yield* sessionKeyOf;
  const keys = yield* Redis.use((redis) => redis.send("KEYS", sessionKey("*"))).pipe(
    Effect.flatMap(S.decodeUnknownEffect(S.Array(S.String))),
    Effect.orDie,
  );
  const hashes = yield* Effect.forEach(keys, readKey);
  return hashes.filter((hash) => hash["user_id"] === userId);
});

layer(
  SessionService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, TestValkeyLive)),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("SessionService", (it) => {
  it.effect("mints a session the database and the cache agree on", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const suffix = yield* randomSuffix;
      const user = yield* PgRootDB.use((rootDb) => createUser(rootDb, `session_mint_${suffix}`));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const minted = yield* sessions.createSession(user.id);

          const hash = yield* readHash(minted.id);
          expect(hash["user_id"]).toBe(user.id);
          expect(hash["username"]).toBe(`session_mint_${suffix}`);
          // The column is an enum the cache stores as text; the role the
          // contract carries is this literal, not a widened string.
          expect(hash["role"]).toBe("user");
          expect(hash["is_verified"]).toBe("1");

          const rows = yield* PgRootDB.use((rootDb) => sessionRows(rootDb, user.id));
          expect(rows).toHaveLength(1);
          expect(rows[0]?.id).toBe(hash["session_uuid"]);

          const resolved = yield* sessions.validateSessionToken(minted.token);
          expect(resolved.user).toEqual({
            id: user.id,
            username: `session_mint_${suffix}`,
            role: "user",
            is_verified: true,
          });
          expect(resolved.session?.cookie_id).toBe(minted.id);

          yield* dropHash(minted.id);
        }),
        PgRootDB.use((rootDb) => deleteUser(rootDb, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );

  it.effect("refuses a user that does not exist and caches nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const absent = yield* randomUuid;

      const error = yield* Effect.flip(sessions.createSession(absent));
      expect(error._tag).toBe("NoSuchElementError");

      const rows = yield* PgRootDB.use((rootDb) => sessionRows(rootDb, absent));
      expect(rows).toHaveLength(0);
      // The hash is written after the insert, so a call that never inserted
      // leaves no cached session for a cookie it never issued.
      expect(yield* cachedSessionsFor(absent)).toHaveLength(0);
    }),
  );

  it.effect("reads no session for an absent token", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      expect(yield* sessions.validateSessionToken()).toEqual({ user: null, session: null });
      expect(yield* sessions.validateSessionToken("")).toEqual({ user: null, session: null });
      // Nothing to split on a dot: no cookie id, so no lookup.
      expect(yield* sessions.validateSessionToken("nodot")).toEqual({
        user: null,
        session: null,
      });
    }),
  );

  it.effect("treats a cookie the cache does not hold as absence, not corruption", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const suffix = yield* randomSuffix;

      const { result, lines } = yield* withCapturedLogs(
        sessions.validateSessionToken(`missing_${suffix}.whatever`),
      );

      expect(result).toEqual({ user: null, session: null });
      // An expired, revoked or invented cookie is every visitor's normal
      // state. Warning about it would log this server's own code as broken
      // on a request anyone can make.
      expect(lines).toEqual([]);
    }),
  );

  it.effect("warns and stays anonymous when a cached session does not decode", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const suffix = yield* randomSuffix;
      const cookieId = `badrole_${suffix}`;

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* writeHash(cookieId, {
            secret_hash: "00",
            session_uuid: yield* randomUuid,
            user_id: yield* randomUuid,
            username: `badrole_${suffix}`,
            // Not a member of UserRole. The old code widened the cached role
            // and asserted it back, so this reached the contract as a role.
            role: "visitor",
            is_verified: "1",
          });

          const { result, lines } = yield* withCapturedLogs(
            sessions.validateSessionToken(`${cookieId}.whatever`),
          );

          expect(result).toEqual({ user: null, session: null });
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain("does not match the shape this server writes");
        }),
        dropHash(cookieId),
      );
    }),
  );

  it.effect("drops a cached session whose row is gone", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const suffix = yield* randomSuffix;
      const user = yield* PgRootDB.use((rootDb) => createUser(rootDb, `session_revoked_${suffix}`));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const minted = yield* sessions.createSession(user.id);
          const hash = yield* readHash(minted.id);
          const sessionUuid = hash["session_uuid"];
          expect(sessionUuid).toBeTruthy();

          // Password reset and account deletion revoke by deleting the row,
          // not by touching the cache.
          yield* PgRootDB.use((rootDb) => deleteSessionRow(rootDb, String(sessionUuid)));

          expect(yield* sessions.validateSessionToken(minted.token)).toEqual({
            user: null,
            session: null,
          });
          // Revocation takes effect at once instead of waiting out the
          // cache's 30-day expiry, so the hash is gone too.
          expect(yield* readHash(minted.id)).toEqual({});
        }),
        PgRootDB.use((rootDb) => deleteUser(rootDb, user.id)).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );
});
