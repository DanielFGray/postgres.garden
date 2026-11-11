import { Effect, Layer, Redacted } from "effect";
import { CurrentSession, SessionMiddleware, type SessionData } from "../../shared/session.js";
import { SessionService } from "./sessionService.js";

const noSession: SessionData = { user: null, session: null };

/**
 * Resolves the session cookie for an endpoint and provides it as
 * `CurrentSession`. A handler that queries as the visitor wraps that work in
 * `withAuthContext`, which binds this session for RLS.
 *
 * A failed session lookup is treated as anonymous, so a database outage reads
 * as a logged-out visitor.
 */
export const SessionMiddlewareLive = Layer.effect(
  SessionMiddleware,
  Effect.gen(function* () {
    const sessionService = yield* SessionService;
    return SessionMiddleware.of({
      session: Effect.fn("SessionMiddleware.session")(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        const session = token
          ? yield* sessionService
              .validateSessionToken(token)
              .pipe(Effect.orElseSucceed(() => noSession))
          : noSession;
        return yield* Effect.provideService(httpEffect, CurrentSession, session);
      }),
    });
  }),
);
