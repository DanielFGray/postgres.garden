import { NodeCrypto } from "@effect/platform-node";
import { Context, DateTime, Effect, Layer, Option, Schema as S } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { rootQuerier, runQuery } from "../db.js";
import type { SessionData } from "../apiSchema.js";
import { UserRole } from "../models.js";
import { valkey } from "../valkey.js";

export const sessionCookieName = "session";

/** The caller has no valid session. */
const anonymous: SessionData = { user: null, session: null };
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// The platform's Valkey user may touch only keys under the app's name.
export function sessionKey(id: string) {
  return `postgres-garden:session:${id}`;
}

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

export function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (aVal === undefined || bVal === undefined) return false;
    result |= aVal ^ bVal;
  }
  return result === 0;
}

export class SessionService extends Context.Service<SessionService>()("SessionService", {
  make: Effect.gen(function* () {
    const runRoot = yield* rootQuerier;
    const secureRandom = yield* SecureRandom.SecureRandom;
    const digest = yield* Digest.Digest;

    /** `length` random bytes as hex. */
    const generateSecureRandomString = (length = 32) =>
      secureRandom
        .randomBytes(length)
        .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));

    const hashSecret = (secret: string) =>
      digest.digest(Digest.sha256, new TextEncoder().encode(secret));

    return {
      createSession: Effect.fnUntraced(function* (userId: string) {
        const user = yield* runRoot((rootDb) =>
          runQuery(
            rootDb
              .selectFrom("app_public.users")
              .select(["id", "username", "role", "is_verified"])
              .where("id", "=", userId),
          ).pipe(Effect.head),
        );

        const id = yield* generateSecureRandomString();
        const secret = yield* generateSecureRandomString();
        const secretHash = Buffer.from(yield* hashSecret(secret)).toString("hex");
        const sessionUuid = yield* secureRandom.uuidV4();
        const expiresAt = DateTime.toDate(
          DateTime.add(DateTime.nowUnsafe(), { milliseconds: SESSION_TTL_MS }),
        );

        const key = sessionKey(id);
        yield* Effect.tryPromise(() =>
          valkey.hset(key, {
            secret_hash: secretHash,
            session_uuid: sessionUuid,
            user_id: user.id,
            username: user.username,
            role: user.role,
            is_verified: user.is_verified ? "1" : "0",
          }),
        );
        yield* Effect.tryPromise(() => valkey.expire(key, SESSION_TTL_SECONDS));

        yield* runRoot((rootDb) =>
          runQuery(
            rootDb.insertInto("app_private.sessions").values({
              id: sessionUuid,
              user_id: user.id,
              expires_at: expiresAt,
            }),
          ),
        );

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

        const data = yield* Effect.tryPromise(() => valkey.hgetall(sessionKey(id)));

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

        const incomingHash = yield* hashSecret(secret);
        const storedHash = Buffer.from(cached.secret_hash, "hex");
        if (!constantTimeEqual(incomingHash, storedHash)) return anonymous;

        // The Valkey cache can outlive the row it was minted from: password
        // reset and account deletion revoke by deleting the row in
        // app_private.sessions, not by touching the cache. Cross-check the
        // row is still there and unexpired so revocation takes effect
        // immediately instead of waiting up to SESSION_TTL_MS for the cache
        // to expire.
        const dbSession = yield* runRoot((rootDb) =>
          runQuery(
            rootDb
              .selectFrom("app_private.sessions")
              .select(["expires_at"])
              .where("id", "=", cached.session_uuid),
          ).pipe(Effect.head, Effect.option),
        );
        if (
          dbSession._tag === "None" ||
          dbSession.value.expires_at == null ||
          dbSession.value.expires_at < DateTime.toDate(DateTime.nowUnsafe())
        ) {
          yield* Effect.tryPromise(() => valkey.del(sessionKey(id)));
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
        const sessionUuid = yield* Effect.tryPromise(() => valkey.hget(key, "session_uuid"));
        yield* Effect.tryPromise(() => valkey.del(key));
        if (sessionUuid) {
          yield* runRoot((rootDb) =>
            runQuery(rootDb.deleteFrom("app_private.sessions").where("id", "=", sessionUuid)),
          );
        }
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(NodeCrypto.layer));
}
