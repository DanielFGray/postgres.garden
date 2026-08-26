import { HttpApiBuilder, HttpApp, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { SessionService } from "./sessionService.js";
import { sessionCookie, SessionMiddleware } from "../apiSchema.js";
import { env } from "../assertEnv.js";

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
        return sessionService
          .validateSessionToken(token)
          .pipe(Effect.orElseSucceed(() => noSession));
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
