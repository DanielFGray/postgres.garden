import { Effect, Layer, Redacted } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  CurrentSession,
  SessionMiddleware,
  sessionCookie,
  type SessionData,
} from "../apiSchema.js";
import { withRequestTransaction } from "../db.js";
import { env } from "../assertEnv.js";
import { ServerError } from "../errors.js";
import { SessionService } from "./sessionService.js";

const noSession: SessionData = { user: null, session: null };

/**
 * Resolves the session cookie for an endpoint and runs the endpoint inside one
 * shared database transaction, so every query the request makes sees the same
 * RLS identity.
 *
 * A failed session lookup is treated as anonymous, so a database outage reads
 * as a logged-out visitor.
 */
export const SessionMiddlewareLive = Layer.effect(
  SessionMiddleware,
  Effect.gen(function* () {
    const sessionService = yield* SessionService;
    return SessionMiddleware.of({
      session: Effect.fn(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        const session = token
          ? yield* sessionService
              .validateSessionToken(token)
              .pipe(Effect.orElseSucceed(() => noSession))
          : noSession;
        return yield* withRequestTransaction(
          Effect.provideService(httpEffect, CurrentSession, session),
        ).pipe(
          Effect.catchTag("DatabaseError", (cause) =>
            Effect.logError(cause).pipe(
              Effect.andThen(Effect.fail(new ServerError({ error: "Internal Server Error" }))),
            ),
          ),
        );
      }),
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

// The cookie name and options are fixed literals, so a failure here is a
// programming error and dies instead of surfacing as a typed error.
export const expireSessionCookie = HttpEffect.appendPreResponseHandler((_req, response) =>
  HttpServerResponse.expireCookie(response, "session", {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
  }).pipe(Effect.orDie),
);
