import { Cause, Effect, Option, Record } from "effect";

import {
  Conflict,
  type DatabaseRefusal,
  Forbidden,
  InvalidOperation,
  Locked,
  NotFound,
  ServiceUnavailable,
  Unauthorized,
} from "../shared/errors.js";
import { type DatabaseError, PostgresError, type PostgresReport } from "./db.js";

/**
 * The HTTP answer to a failed database call: the one table that says what each
 * Postgres code means to a client.
 *
 * - A custom code that our SQL raises is answered with the SQL's own message,
 *   which was written for users. Only these codes pass Postgres text on.
 * - A standard code is answered with fixed text, because Postgres's message can
 *   name tables, columns and values.
 * - Any other failure is unexpected: it dies, and FailureBoundary logs it and
 *   answers 500 with the trace id.
 *
 * Expected failures are logged here, so that each failure has one log line.
 */
export const toHttpError = Effect.fn("DatabaseErrors.toHttpError")(function* (
  error: DatabaseError,
) {
  const refusal = Option.flatMap(error.report, (report) =>
    Option.orElse(
      Option.map(Record.get(customCodes, report.code), (answer) => ({
        answer: answer(report.message),
        log: Effect.logInfo,
      })),
      () =>
        Option.map(standardCode(report), (answer) => ({
          answer,
          log: Effect.logWarning,
        })),
    ),
  );
  return yield* Option.match(refusal, {
    onNone: () => Effect.die(error),
    onSome: ({ answer, log }) =>
      log("Database refused the request", Cause.fail(error)).pipe(
        Effect.andThen(Effect.fail(answer)),
      ),
  });
});

/**
 * Custom SQLSTATEs raised by the SQL functions in migrations/. Each one's
 * message is written for users.
 */
const customCodes: Record<string, (message: string) => DatabaseRefusal> = {
  CREDS: (message) => new Unauthorized({ message, reason: "invalid_credentials" }),
  LOGIN: (message) => new Unauthorized({ message, reason: "authentication_required" }),
  LOCKD: (message) => new Locked({ message }),
  DNIED: (message) => new Forbidden({ message, reason: "access_denied" }),
  NTFND: (message) => new NotFound({ message }),
  WEAKP: (message) => new InvalidOperation({ message, reason: "weak_password" }),
  MODAT: (message) => new InvalidOperation({ message, reason: "missing_data" }),
  CDLEA: (message) => new InvalidOperation({ message, reason: "cannot_delete_last_email" }),
  VRFY1: (message) => new InvalidOperation({ message, reason: "email_not_verified" }),
  VRFY2: (message) => new InvalidOperation({ message, reason: "email_not_verified" }),
  TAKEN: (message) => new Conflict({ message, reason: "account_already_linked" }),
  EMTKN: (message) => new Conflict({ message, reason: "email_taken" }),
  ISMBR: (message) => new Conflict({ message, reason: "already_member" }),
  OWNER: (message) => new Conflict({ message, reason: "owns_organization" }),
  STALE: (message) => new Conflict({ message, reason: "stale_basis" }),
};

/**
 * Standard SQLSTATEs a client can cause, with fixed text.
 *
 * - 23505 unique: 409, named by the constraint when it is one users can hit.
 * - 23503 foreign key: 409, because the request is well formed but conflicts
 *   with rows that exist (or no longer exist) now.
 * - 42501 insufficient privilege, which is also how Postgres refuses a row
 *   that a row-level security policy rejects: 403.
 * - 23502 not null, 23514 check, and class 22 (data exception: a value out of
 *   range or in the wrong format): 400 invalid_input.
 * - 40001 serialization failure and 40P01 deadlock: 503 busy. The server does
 *   not retry, because a request can have effects outside its transaction; the
 *   client may send it again.
 * - 57014 query canceled (a statement timeout): 503 timed_out.
 */
const standardCode = (report: PostgresReport): Option.Option<DatabaseRefusal> =>
  Option.orElse(
    Option.map(Record.get(fixedAnswers, report.code), (answer) => answer(report)),
    () => (report.code.startsWith("22") ? Option.some(invalidInput) : Option.none()),
  );

const invalidInput = new InvalidOperation({
  message: "Some values are not valid.",
  reason: "invalid_input",
});

const busy = new ServiceUnavailable({
  message: "The server is busy. Try again.",
  reason: "busy",
});

const fixedAnswers: Record<string, (report: PostgresReport) => DatabaseRefusal> = {
  [PostgresError.UNIQUE_VIOLATION]: (report) =>
    Option.getOrElse(
      Option.flatMap(report.constraint, (constraint) => Record.get(uniqueConstraints, constraint)),
      () => new Conflict({ message: "That already exists.", reason: "already_exists" }),
    ),
  [PostgresError.FOREIGN_KEY_VIOLATION]: () =>
    new Conflict({
      message: "This change conflicts with related data.",
      reason: "related_data",
    }),
  [PostgresError.INSUFFICIENT_PRIVILEGE]: () =>
    new Forbidden({
      message: "You do not have permission to do that.",
      reason: "access_denied",
    }),
  [PostgresError.NOT_NULL_VIOLATION]: () => invalidInput,
  [PostgresError.CHECK_VIOLATION]: () => invalidInput,
  [PostgresError.T_R_SERIALIZATION_FAILURE]: () => busy,
  [PostgresError.T_R_DEADLOCK_DETECTED]: () => busy,
  [PostgresError.QUERY_CANCELED]: () =>
    new ServiceUnavailable({
      message: "The request took too long. Try again.",
      reason: "timed_out",
    }),
};

/** Unique constraints a user can hit, by the name Postgres reports. */
const uniqueConstraints: Record<string, DatabaseRefusal> = {
  users_username_key: new Conflict({
    message: "That username is already taken.",
    reason: "username_taken",
  }),
  uniq_user_emails_verified_email: new Conflict({
    message: "That email address is already in use.",
    reason: "email_taken",
  }),
  user_emails_user_id_email_key: new Conflict({
    message: "That email address is already on your account.",
    reason: "email_taken",
  }),
  organizations_slug_key: new Conflict({
    message: "That slug is already in use.",
    reason: "slug_taken",
  }),
};
