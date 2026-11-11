import { Array as Arr, Context, Effect, Layer, Match, Option, Schema } from "effect";
import { sql } from "kysely";

import packageJson from "../package.json" with { type: "json" };
import { rootUrl } from "../server/config.js";
import { PgRootDB } from "../server/db.js";
import { QueuedEmail } from "./email/sendEmail.js";

/**
 * Turns account events into queued mail. The SQL in `migrations/` queues one
 * job per event (`graphile_worker.add_job`); each method here handles one of
 * those jobs and queues a `send_email` job, which `sendEmail` delivers.
 *
 * The payload schemas below are written from that SQL: it is their only
 * producer.
 */
export class AccountMail extends Context.Service<AccountMail>()("Worker/AccountMail", {
  make: Effect.gen(function* () {
    const db = yield* PgRootDB;

    const queue = (email: QueuedEmail) =>
      Effect.flatMap(emailJob(email), (statement) => db.all(db.raw(statement)));

    const userExists = (userId: string) =>
      db.maybe(
        db.connection.selectFrom("app_public.users").select("created_at").where("id", "=", userId),
      );

    return {
      /**
       * Tells the user about an action on their account, at every verified
       * address. `queuedAt` is when the event's job was queued.
       */
      audit: Effect.fn("AccountMail.audit")(function* (event: AuditEvent, queuedAt: Date) {
        const { subject, actionDescription } = describe(event);
        const user = yield* userExists(event.user_id);
        if (Option.isNone(user)) {
          return yield* Effect.logWarning(
            `User ${event.user_id} no longer exists; not sent: ${actionDescription}`,
          );
        }
        // Registration adds the first email in the transaction that creates the
        // user, and both rows take that transaction's now(). That event is the
        // sign-up itself, so it gets no notice.
        if (Math.abs(user.value.created_at.getTime() - queuedAt.getTime()) < 2) {
          return yield* Effect.logInfo(
            `Not sent, because it came with the account's creation: ${actionDescription}`,
          );
        }
        const emails = yield* db.all(
          db.connection
            .selectFrom("app_public.user_emails")
            .select("email")
            .where("user_id", "=", event.user_id)
            .where("is_verified", "=", true)
            .orderBy("id", "asc"),
        );
        const to = Arr.map(emails, (row) => row.email);
        if (!Arr.isReadonlyArrayNonEmpty(to)) {
          return yield* new NoVerifiedEmail({ userId: event.user_id });
        }
        return yield* queue({
          options: { to, subject: `[${packageJson.projectName}] ${subject}` },
          template: "account_activity.mjml",
          variables: { actionDescription },
        });
      }),

      forgotPassword: Effect.fn("AccountMail.forgotPassword")(function* ({
        id,
        email,
        token,
      }: ForgotPassword) {
        if (Option.isNone(yield* userExists(id))) {
          return yield* Effect.logWarning(`User ${id} no longer exists; reset mail not sent`);
        }
        return yield* queue({
          options: { to: email, subject: "Password reset" },
          template: "password_reset.mjml",
          variables: { token, verifyLink: yield* link("/reset", token) },
        });
      }),

      forgotPasswordUnregistered: Effect.fn("AccountMail.forgotPasswordUnregistered")(function* ({
        email,
      }: ForgotPasswordUnregistered) {
        yield* queue({
          options: {
            to: email,
            subject: `Password reset request failed: you don't have a ${packageJson.projectName} account`,
          },
          template: "password_reset_unregistered.mjml",
          variables: { url: yield* rootUrl },
        });
      }),

      sendDeleteAccount: Effect.fn("AccountMail.sendDeleteAccount")(function* ({
        email,
        token,
      }: DeleteAccount) {
        yield* queue({
          options: { to: email, subject: "Confirmation required: really delete account?" },
          template: "delete_account.mjml",
          variables: {
            token,
            deleteAccountLink: yield* link("/settings", token),
          },
        });
      }),

      /**
       * Sends the link that verifies an address, while the job's token is the
       * address's live token: a newer token has replaced it when the user asked
       * again, and its own job mails it. The mail is queued and the send time
       * recorded in one transaction, and a send time after the token's mint
       * means its mail went out, so a retried job does not mail twice.
       */
      sendVerification: Effect.fn("AccountMail.sendVerification")(function* ({
        id,
        token,
      }: SendVerification) {
        const pending = yield* db.maybe(
          db.connection
            .selectFrom("app_public.user_emails as address")
            .innerJoin(
              "app_private.user_email_secrets as secrets",
              "secrets.user_email_id",
              "address.id",
            )
            .innerJoin("app_public.users as user", "user.id", "address.user_id")
            .select((eb) => [
              "address.email",
              "user.username",
              "user.name",
              eb(
                "secrets.verification_email_sent_at",
                ">=",
                eb.ref("secrets.verification_token_generated"),
              ).as("already_sent"),
            ])
            .where("address.id", "=", id)
            .where("address.is_verified", "=", false)
            .where(
              "secrets.verification_token_hash",
              "=",
              sql<string>`app_private.hash_token(${token})`,
            ),
        );
        if (Option.isNone(pending)) {
          return yield* Effect.logWarning(
            `Email ${id} is gone, verified, or has a newer token; verification mail not sent`,
          );
        }
        const { email, username, name, already_sent } = pending.value;
        if (already_sent) {
          return yield* Effect.logInfo(`The verification mail for email ${id} already went out`);
        }
        const verifyLink = yield* link("/verify", token);
        const statement = yield* emailJob({
          options: { to: email, subject: "Please verify your email address" },
          template: "verify_email.mjml",
          variables: { token, verifyLink, username, name },
        });
        return yield* db.transaction((trx) =>
          Effect.gen(function* () {
            yield* trx.all(trx.raw(statement));
            yield* trx.all(
              trx.connection
                .updateTable("app_private.user_email_secrets")
                .set({ verification_email_sent_at: sql<Date>`now()` })
                .where("user_email_id", "=", id),
            );
          }),
        );
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/** A password audit names only the user. */
const PasswordEvent = <T extends string>(type: T) =>
  Schema.Struct({ type: Schema.Literal(type), user_id: Schema.String });

/**
 * An audit of a row change, from `app_private.tg__add_audit_job` or the OAuth
 * link function: `extra1` and `extra2` are the changed row's id and email, or
 * the provider and its account id.
 */
const RowEvent = <T extends string>(type: T) =>
  Schema.Struct({
    type: Schema.Literal(type),
    user_id: Schema.String,
    extra1: Schema.String,
    extra2: Schema.String,
  });

export const AuditEvent = Schema.Union([
  RowEvent("added_email"),
  RowEvent("removed_email"),
  RowEvent("linked_account"),
  RowEvent("unlinked_account"),
  PasswordEvent("reset_password"),
  PasswordEvent("change_password"),
]);
export type AuditEvent = typeof AuditEvent.Type;

export const ForgotPassword = Schema.Struct({
  id: Schema.String,
  email: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
export type ForgotPassword = typeof ForgotPassword.Type;

export const ForgotPasswordUnregistered = Schema.Struct({ email: Schema.NonEmptyString });
export type ForgotPasswordUnregistered = typeof ForgotPasswordUnregistered.Type;

export const DeleteAccount = Schema.Struct({
  email: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
});
export type DeleteAccount = typeof DeleteAccount.Type;

/**
 * From the SQL that mints a verification token. The database keeps only the
 * token's hash, so this payload is the one place the plaintext exists.
 */
export const SendVerification = Schema.Struct({
  id: Schema.String,
  token: Schema.NonEmptyString,
});
export type SendVerification = typeof SendVerification.Type;

/** An audit for a user with no verified address: no one can be told, so the job fails. */
export class NoVerifiedEmail extends Schema.TaggedError<
  NoVerifiedEmail,
  { readonly brand: unique symbol }
>()("NoVerifiedEmail", { userId: Schema.String }) {}

const QueuedEmailJson = Schema.fromJsonString(QueuedEmail);

/** The statement that queues `email` for `sendEmail`. */
const emailJob = Effect.fnUntraced(function* (email: QueuedEmail) {
  const json = yield* Schema.encodeEffect(QueuedEmailJson)(email);
  return sql`select graphile_worker.add_job('send_email', ${json}::json)`;
});

/**
 * The token alone finds its row, so it is the link's only parameter. It travels
 * in the fragment, which no request carries, so it never reaches server logs or
 * a Referer header. `src/features/auth.ts` reads it from there.
 */
const link = (path: string, token: string) =>
  Effect.map(rootUrl, (url) => `${url}${path}#token=${encodeURIComponent(token)}`);

const describe = Match.type<AuditEvent>().pipe(
  Match.discriminatorsExhaustive("type")({
    added_email: ({ extra2 }) => ({
      subject: "You added an email to your account",
      actionDescription: `You added the email '${extra2}' to your account.`,
    }),
    removed_email: ({ extra2 }) => ({
      subject: "You removed an email from your account",
      actionDescription: `You removed the email '${extra2}' from your account.`,
    }),
    linked_account: ({ extra1 }) => ({
      subject: "You linked a third-party OAuth provider to your account",
      actionDescription: `You linked a third-party OAuth provider ('${extra1}') to your account.`,
    }),
    unlinked_account: ({ extra1 }) => ({
      subject: "You removed a link between your account and a third-party OAuth provider",
      actionDescription: `You removed a link between your account and a third-party OAuth provider ('${extra1}').`,
    }),
    reset_password: () => ({
      subject: "You reset your password",
      actionDescription: "You reset your password.",
    }),
    change_password: () => ({
      subject: "You changed your password",
      actionDescription: "You changed your password.",
    }),
  }),
);
