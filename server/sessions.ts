import crypto from "crypto";
import { rootDb } from "./db.js";
import { valkey } from "./valkey.js";
import { env } from "./assertEnv.js";

export const sessionCookieName = "session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sessionKey(id: string) {
  return `session:${id}`;
}

export async function createSession(userId: string) {
  // Fetch user data from Postgres (once, at login time)
  const user = await rootDb
    .selectFrom("app_public.users")
    .select(["id", "username", "role", "is_verified"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  // Two independent secrets:
  //   id + secret → Valkey/cookie layer (HTTP session)
  //   sessionUuid → Postgres layer (RLS via current_user_id())
  const id = generateSecureRandomString();
  const secret = generateSecureRandomString();
  const secretHash = hashSecret(secret).toString("hex");
  const sessionUuid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const key = sessionKey(id);
  await valkey.hset(key, {
    secret_hash: secretHash,
    session_uuid: sessionUuid,
    user_id: user.id,
    username: user.username,
    role: user.role,
    is_verified: user.is_verified ? "1" : "0",
  });
  await valkey.expire(key, SESSION_TTL_SECONDS);

  // Write to app_private.sessions so current_user_id() works for RLS
  await rootDb
    .insertInto("app_private.sessions")
    .values({
      id: sessionUuid,
      user_id: user.id,
      expires_at: expiresAt,
    })
    .execute();

  return { token: `${id}.${secret}`, id, expiresAt };
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

export async function validateSessionToken(token?: string) {
  if (!token) {
    return { user: null, session: null } as const;
  }
  const [id, secret] = token.split(".");
  if (!(id && secret)) {
    return { user: null, session: null } as const;
  }

  const data = await valkey.hgetall(sessionKey(id));
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
    id: data.session_uuid ?? "", // Postgres UUID for withAuthContext/RLS
    cookie_id: id, // Valkey key for deletion
    user_id: data.user_id ?? "",
    expires_at: new Date(), // TTL is managed by Valkey
  };
  return { user, session } as const;
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

export async function deleteSession(cookieId: string) {
  const key = sessionKey(cookieId);
  // Read the Postgres session UUID before deleting from Valkey
  const sessionUuid = await valkey.hget(key, "session_uuid");
  await valkey.del(key);
  if (sessionUuid) {
    await rootDb.deleteFrom("app_private.sessions").where("id", "=", sessionUuid).execute();
  }
}
