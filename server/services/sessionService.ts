import crypto from "crypto";
import { Effect } from "effect";
import { PgRootDB } from "../db.js";
import { valkey } from "../valkey.js";
import { env } from "../assertEnv.js";

export const sessionCookieName = "session";
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
    const rootDb = yield* PgRootDB;

    return {
      createSession: (userId: string) =>
        Effect.gen(function* () {
          const user = yield* rootDb
            .selectFrom("app_public.users")
            .select(["id", "username", "role", "is_verified"])
            .where("id", "=", userId)
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                Effect.dieMessage(`User not found: ${userId}`),
              ),
            );

          const id = generateSecureRandomString();
          const secret = generateSecureRandomString();
          const secretHash = hashSecret(secret).toString("hex");
          const sessionUuid = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

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

          yield* rootDb
            .insertInto("app_private.sessions")
            .values({
              id: sessionUuid,
              user_id: user.id,
              expires_at: expiresAt,
            });

          return { token: `${id}.${secret}`, id, expiresAt };
        }),

      validateSessionToken: (token?: string) =>
        Effect.gen(function* () {
          if (!token) {
            return { user: null, session: null } as const;
          }
          const [id, secret] = token.split(".");
          if (!(id && secret)) {
            return { user: null, session: null } as const;
          }

          const data = yield* Effect.tryPromise(() => valkey.hgetall(sessionKey(id)));
          if (!data || !data.secret_hash) {
            return { user: null, session: null } as const;
          }

          const incomingHash = hashSecret(secret);
          const storedHash = Buffer.from(data.secret_hash, "hex");
          if (!constantTimeEqual(incomingHash, storedHash)) {
            return { user: null, session: null } as const;
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
            expires_at: new Date(),
          };
          return { user, session } as const;
        }),

      deleteSession: (cookieId: string) =>
        Effect.gen(function* () {
          const key = sessionKey(cookieId);
          const sessionUuid = yield* Effect.tryPromise(() => valkey.hget(key, "session_uuid"));
          yield* Effect.tryPromise(() => valkey.del(key));
          if (sessionUuid) {
            yield* rootDb
              .deleteFrom("app_private.sessions")
              .where("id", "=", sessionUuid);
          }
        }),
    } as const;
  }),
  dependencies: [PgRootDB.Live],
  accessors: true,
}) {}
