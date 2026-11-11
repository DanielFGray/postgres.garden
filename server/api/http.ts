/**
 * Helpers every handler group shares: reading the edit key and requiring a
 * session. A refused query is answered with `toHttpError`
 * (`server/databaseErrors.ts`).
 */
import { Effect, Option } from "effect";
import { EDIT_KEY_HEADER } from "../../shared/api/playgrounds.js";
import { CurrentSession } from "../../shared/session.js";
import { Unauthorized } from "../../shared/errors.js";

type RequestHeaders = Record<string, string | ReadonlyArray<string> | undefined>;

/**
 * The edit key a request carries, if any.
 *
 * Like the session cookie, the key is a credential the transport carries rather
 * than data an endpoint declares, so it is read off the request here and handed
 * to the database, which decides whether it holds.
 */
export const editKeyFrom = (headers: RequestHeaders): string | null => {
  const value = headers[EDIT_KEY_HEADER];
  return typeof value === "string" ? value : (value?.[0] ?? null);
};

/** The signed-in session and user, or Unauthorized. */
export const requireSession = CurrentSession.pipe(
  Effect.flatMap(({ session, user }) =>
    Effect.fromOption(
      Option.all({ session: Option.fromNullishOr(session), user: Option.fromNullishOr(user) }),
    ),
  ),
  Effect.catchTag("NoSuchElementError", () =>
    Effect.fail(
      new Unauthorized({ message: "Sign in to do that.", reason: "authentication_required" }),
    ),
  ),
);
