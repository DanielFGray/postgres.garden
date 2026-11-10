/**
 * The session as the contract sees it: the cookie that carries it, the
 * identity a request resolves to, and the middleware that resolves it. The
 * middleware's implementation lives in `server/services/sessionMiddleware.ts`.
 */
import { Context } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { ServerError } from "./errors.js";
import type { UserRole } from "./schemas.js";

export const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "session" });

export type SessionInfo = {
  readonly id: string;
  readonly cookie_id: string;
  readonly user_id: string;
  readonly expires_at: Date;
};

/**
 * Session state rehydrated from the Valkey cache. `validateSessionToken`
 * decodes the cached hash against a schema, so a session either carries the
 * fields a user row has or there is no session at all.
 */
export type SessionData = {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: typeof UserRole.Type;
    readonly is_verified: boolean;
  } | null;
  readonly session: SessionInfo | null;
};

export class CurrentSession extends Context.Service<CurrentSession, SessionData>()(
  "CurrentSession",
) {}

export class SessionMiddleware extends HttpApiMiddleware.Service<
  SessionMiddleware,
  {
    provides: CurrentSession;
  }
>()("SessionMiddleware", {
  security: { session: sessionCookie },
  error: ServerError,
}) {}
