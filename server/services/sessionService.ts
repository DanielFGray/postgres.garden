import { NodeCrypto } from "@effect/platform-node";
import { Config, Context, DateTime, Effect, Layer, Option, Record, Schema as S } from "effect";
import { SecureRandom } from "effect/crypto";
import { Redis } from "effect/persistence/Redis";
import { PgRootDB } from "../db.js";
import type { SessionData } from "../../shared/session.js";
import { UserRole } from "../../shared/schemas.js";
import { Secrets, constantTimeEqual } from "../secrets.js";

export const sessionCookieName = "session";

/** The caller has no valid session. */
const anonymous: SessionData = { user: null, session: null };
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The Valkey key of a session hash, by cookie id. The platform's Valkey user may
 * touch only keys under `VALKEY_KEY_PREFIX`, the app's name and a colon.
 */
export const sessionKeyOf = Config.String("VALKEY_KEY_PREFIX").pipe(
  Config.map((prefix) => (id: string) => `${prefix}session:${id}`),
);

/** Valkey answers HGETALL with a flat string map; a missing key is `{}`. */
const decodeHash = S.decodeUnknownEffect(S.Record(S.String, S.String));
const decodeField = S.decodeUnknownEffect(S.NullOr(S.String));

/**
 * The fields `createSession` writes into the session's Valkey hash.
 *
 * Everything in a hash is a string, so the role and the verified flag are read
 * back through this schema and the rest of the server works with the typed
 * values. A hash that does not decode was not written by this code in this
 * shape, so its bearer is an anonymous visitor: inventing a role or an empty
 * user id would hand the contract a value it promises never to carry.
 */
const CachedSession = S.Struct({
  secret_hash: S.String,
  session_uuid: S.String.check(S.isUUID()),
  user_id: S.String.check(S.isUUID()),
  username: S.String,
  role: UserRole,
  is_verified: S.Literals(["0", "1"]),
});

const decodeCachedSession = S.decodeUnknownEffect(CachedSession);

export class SessionService extends Context.Service<SessionService>()("SessionService", {
  make: Effect.gen(function* () {
    const root = yield* PgRootDB;
    const secureRandom = yield* SecureRandom.SecureRandom;
    const secrets = yield* Secrets;
    const redis = yield* Redis;
    const sessionKey = yield* sessionKeyOf;

    return {
      createSession: Effect.fnUntraced(function* (userId: string) {
        const id = yield* secrets.generate;
        const secret = yield* secrets.generate;
        const secretHash = (yield* secrets.digest(secret)).toString("hex");
        const sessionUuid = yield* secureRandom.uuidV4();
        const expiresAt = DateTime.toDate(
          DateTime.add(DateTime.nowUnsafe(), { milliseconds: SESSION_TTL_MS }),
        );

        // The read and the insert must stay in one transaction, and the read
        // must keep its `for key share`: that lock is what makes the insert's
        // foreign key safe. An account deletion needs a stronger lock on the
        // same row, so it either commits first - the read then finds nothing,
        // which the callers answer as an authentication failure - or it waits
        // for this transaction and cascades the new session away afterwards.
        const user = yield* root.transaction((trx) =>
          Effect.gen(function* () {
            const found = yield* trx
              .all(
                trx.connection
                  .selectFrom("app_public.users")
                  .select(["id", "username", "role", "is_verified"])
                  .where("id", "=", userId)
                  .forKeyShare(),
              )
              .pipe(Effect.head);

            yield* trx.all(
              trx.connection.insertInto("app_private.sessions").values({
                id: sessionUuid,
                user_id: found.id,
                expires_at: expiresAt,
              }),
            );

            return found;
          }),
        );

        // The cache is written only once the session row exists, so a failed
        // insert leaves no hash behind for a cookie that was never issued.
        const key = sessionKey(id);
        yield* redis.send(
          "HSET",
          key,
          "secret_hash",
          secretHash,
          "session_uuid",
          sessionUuid,
          "user_id",
          user.id,
          "username",
          user.username,
          "role",
          user.role,
          "is_verified",
          user.is_verified ? "1" : "0",
        );
        yield* redis.send("EXPIRE", key, String(SESSION_TTL_SECONDS));

        return { token: `${id}.${secret}`, id, expiresAt };
      }),

      /**
       * Resolve a session cookie to the caller's identity. An absent, malformed
       * or unrecognised token is an anonymous visitor, not an error.
       */
      validateSessionToken: Effect.fnUntraced(function* (token?: string) {
        if (!token) return anonymous;

        const [id, secret] = token.split(".");
        if (!(id && secret)) return anonymous;

        const data = yield* redis.send("HGETALL", sessionKey(id)).pipe(Effect.flatMap(decodeHash));
        // Valkey answers a key it does not hold with an empty hash, which is
        // every expired, revoked and invented cookie. That is absence, not a
        // session written in the wrong shape, so it must not reach the decode
        // below: otherwise any junk cookie logs a warning about this code.
        if (Record.isEmptyRecord(data)) return anonymous;

        const decoded = yield* decodeCachedSession(data).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("A cached session does not match the shape this server writes").pipe(
              Effect.annotateLogs({ reason: error.message }),
            ),
          ),
          Effect.option,
        );
        if (Option.isNone(decoded)) return anonymous;
        const cached = decoded.value;

        const incomingHash = yield* secrets.digest(secret);
        const storedHash = Buffer.from(cached.secret_hash, "hex");
        if (!constantTimeEqual(incomingHash, storedHash)) return anonymous;

        // The Valkey cache can outlive the row it was minted from: password
        // reset and account deletion revoke by deleting the row in
        // app_private.sessions, not by touching the cache. Cross-check the
        // row is still there and unexpired so revocation takes effect
        // immediately instead of waiting up to SESSION_TTL_MS for the cache
        // to expire.
        const dbSession = yield* root
          .all(
            root.connection
              .selectFrom("app_private.sessions")
              .select(["expires_at"])
              .where("id", "=", cached.session_uuid),
          )
          .pipe(Effect.head, Effect.option);
        if (
          dbSession._tag === "None" ||
          dbSession.value.expires_at == null ||
          dbSession.value.expires_at < DateTime.toDate(DateTime.nowUnsafe())
        ) {
          yield* redis.send("DEL", sessionKey(id));
          return anonymous;
        }

        const user = {
          id: cached.user_id,
          username: cached.username,
          role: cached.role,
          is_verified: cached.is_verified === "1",
        };
        const session = {
          id: cached.session_uuid,
          cookie_id: id,
          user_id: cached.user_id,
          expires_at: dbSession.value.expires_at,
        };
        return { user, session };
      }),

      deleteSession: Effect.fnUntraced(function* (cookieId: string) {
        const key = sessionKey(cookieId);
        const sessionUuid = yield* redis
          .send("HGET", key, "session_uuid")
          .pipe(Effect.flatMap(decodeField));
        yield* redis.send("DEL", key);
        if (sessionUuid) {
          yield* root.all(
            root.connection.deleteFrom("app_private.sessions").where("id", "=", sessionUuid),
          );
        }
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([NodeCrypto.layer, Secrets.layer]),
  );
}
