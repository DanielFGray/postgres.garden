import { HttpApiBuilder, HttpApiMiddleware, HttpApiSecurity, HttpApp, HttpServerResponse } from "@effect/platform";
import { Context, Effect, Layer, Redacted } from "effect";
import { SessionService } from "./sessionService.js";
import { env } from "../assertEnv.js";

export const sessionCookie = HttpApiSecurity.apiKey({ in: "cookie", key: "session" });

export type SessionUser = {
  readonly id: string;
  readonly username: string;
  readonly role: string;
  readonly is_verified: boolean;
};

export type SessionInfo = {
  readonly id: string;
  readonly cookie_id: string;
  readonly user_id: string;
  readonly expires_at: Date;
};

export type SessionData = {
  readonly user: SessionUser | null;
  readonly session: SessionInfo | null;
};

export class CurrentSession extends Context.Tag("CurrentSession")<CurrentSession, SessionData>() {}

export class SessionMiddleware extends HttpApiMiddleware.Tag<SessionMiddleware>()("SessionMiddleware", {
  provides: CurrentSession,
  security: { session: sessionCookie },
}) {}

export const SessionMiddlewareLive = Layer.effect(
  SessionMiddleware,
  Effect.gen(function* () {
    const sessionService = yield* SessionService;
    const noSession = { user: null, session: null } as const;
    return SessionMiddleware.of({
      session: (redactedToken: Redacted.Redacted<string>) => {
        const token = Redacted.value(redactedToken);
        if (!token) {
          return Effect.succeed(noSession);
        }
        return sessionService.validateSessionToken(token).pipe(
          Effect.catchAll(() => Effect.succeed(noSession)),
        );
      },
    });
  }),
);

const isSecure = env.NODE_ENV === "production";

export const setSessionCookie = (token: string, expiresAt: Date) =>
  HttpApiBuilder.securitySetCookie(sessionCookie, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    expires: expiresAt,
  });

export const expireSessionCookie = HttpApp.appendPreResponseHandler((_req, response) =>
  Effect.succeed(
    HttpServerResponse.expireCookie(response, "session", {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecure,
      path: "/",
    }),
  ),
);
