import { Effect, Layer, Redacted } from "effect";
import { CurrentSession, SessionMiddleware, type SessionData } from "../../shared/session.js";
import { withRequestTransaction } from "../db.js";
import { ServerError } from "../../shared/errors.js";
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
