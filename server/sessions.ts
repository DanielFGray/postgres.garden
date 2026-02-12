import crypto from "crypto";
import { rootDb } from "./db.js";
import { env } from "./assertEnv.js";

export const sessionCookieName = "session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function createSession(userId: string) {
  const id = generateSecureRandomString();
  const secret = generateSecureRandomString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await rootDb
    .insertInto("app_private.sessions")
    .values({
      id,
      user_id: userId,
      secret_hash: hashSecret(secret),
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
  const row = await rootDb
    .selectFrom("app_private.sessions as s")
    .innerJoin("app_public.users as u", "u.id", "s.user_id")
    .select([
      "s.id as sid",
      "s.user_id as suid",
      "s.secret_hash as shash",
      "s.expires_at",
      "u.id as uid",
      "u.username",
      "u.role",
      "u.is_verified",
    ])
    .where("s.id", "=", id)
    .where("s.expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) {
    return { user: null, session: null } as const;
  }
  const incomingHash = hashSecret(secret);
  if (!constantTimeEqual(incomingHash, row.shash as unknown as Uint8Array)) {
    return { user: null, session: null } as const;
  }
  const user = {
    id: row.uid,
    username: row.username,
    role: row.role,
    is_verified: row.is_verified,
  };
  const session = {
    id: row.sid,
    user_id: row.suid,
    expires_at: row.expires_at,
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

export async function deleteSession(id: string) {
  await rootDb
    .deleteFrom("app_private.sessions")
    .where("id", "=", id)
    .execute();
}
