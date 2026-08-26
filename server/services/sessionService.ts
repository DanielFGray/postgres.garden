import crypto from "crypto";
import { DateTime, Effect } from "effect";
import { rootQuerier } from "../db.js";
import type { SessionData } from "../apiSchema.js";
import { valkey } from "../valkey.js";
import { env } from "../assertEnv.js";

export const sessionCookieName = "session";

/** The caller has no valid session. */
const anonymous: SessionData = { user: null, session: null };
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sessionKey(id: string) {
  return `session:${id}`;
}

export function generateSecureRandomString(length = 32) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hashSecret(secret: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  return crypto.createHash("sha256").update(data).digest();
}

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

export function buildSessionCookie(token: string, expiresAt: Date) {
  return {
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export class SessionService extends Effect.Service<SessionService>()("SessionService", {
  effect: Effect.gen(function* () {
    const runRoot = yield* rootQuerier;

    return {
      createSession: Effect.fnUntraced(function* (userId: string) {
        const user = yield* runRoot((rootDb) =>
          rootDb
            .selectFrom("app_public.users")
            .select(["id", "username", "role", "is_verified"])
            .where("id", "=", userId)
            .pipe(Effect.head),
        );

        const id = generateSecureRandomString();
        const secret = generateSecureRandomString();
        const secretHash = hashSecret(secret).toString("hex");
        const sessionUuid = crypto.randomUUID();
        const expiresAt = DateTime.toDate(
          DateTime.add(DateTime.unsafeNow(), { millis: SESSION_TTL_MS }),
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
          rootDb.insertInto("app_private.sessions").values({
            id: sessionUuid,
            user_id: user.id,
            expires_at: expiresAt,
          }),
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
        if (!data || !data.secret_hash) return anonymous;

        const incomingHash = hashSecret(secret);
        const storedHash = Buffer.from(data.secret_hash, "hex");
        if (!constantTimeEqual(incomingHash, storedHash)) return anonymous;

        // The Valkey cache can outlive the row it was minted from: password
        // reset and account deletion revoke by deleting the row in
        // app_private.sessions, not by touching the cache. Cross-check the
        // row is still there and unexpired so revocation takes effect
        // immediately instead of waiting up to SESSION_TTL_MS for the cache
        // to expire.
        const dbSession = yield* runRoot((rootDb) =>
          rootDb
            .selectFrom("app_private.sessions")
            .select(["expires_at"])
            .where("id", "=", data.session_uuid ?? "")
            .pipe(Effect.head, Effect.option),
        );
        if (
          dbSession._tag === "None" ||
          dbSession.value.expires_at == null ||
          dbSession.value.expires_at < DateTime.toDate(DateTime.unsafeNow())
        ) {
          yield* Effect.tryPromise(() => valkey.del(sessionKey(id)));
          return anonymous;
        }

        const user = {
          id: data.user_id ?? "",
          username: data.username ?? "",
          role: data.role ?? "visitor",
          is_verified: data.is_verified === "1",
        };
        const session = {
          id: data.session_uuid ?? "",
          cookie_id: id,
          user_id: data.user_id ?? "",
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
            rootDb.deleteFrom("app_private.sessions").where("id", "=", sessionUuid),
          );
        }
      }),
    } as const;
  }),
  accessors: true,
}) {}
