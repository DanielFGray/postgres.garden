import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { sql } from "kysely";

import packageJson from "../package.json" with { type: "json" };
import { rootUrl } from "../server/config.js";
import { PgRootDB } from "../server/db.js";
import { randomSuffix } from "../server/testSupport.js";
import {
  AccountMail,
  AuditEvent,
  ForgotPassword,
  ForgotPasswordUnregistered,
  SendVerification,
} from "./accountMail.js";
import { QueuedEmail } from "./email/sendEmail.js";

/**
 * Each test starts from the SQL that queues a job, runs the job on the payload
 * that SQL queued, and reads the `send_email` jobs it queued in turn. No
 * worker runs against the test database, so queued jobs stay in the table to
 * be read.
 */
layer(Layer.provideMerge(AccountMail.layer, PgRootDB.layer), { timeout: "30 seconds" })(
  "AccountMail",
  (it) => {
    it.effect("mails a new address its verification link once", () =>
      withUsers("vrfy", (marker) =>
        Effect.gen(function* () {
          const { email } = yield* createUser(marker, false);
          const db = yield* PgRootDB;
          const { id } = yield* db.one(
            db.connection
              .selectFrom("app_public.user_emails")
              .select("id")
              .where("email", "=", email),
          );
          const [job] = yield* queuedOnce(SendVerification, "user_emails__send_verification", id);
          const { token } = job.payload;
          const mail = yield* AccountMail;
          yield* mail.sendVerification(job.payload);
          yield* mail.sendVerification(job.payload);
          expect(yield* queuedMail(marker)).toEqual([
            {
              options: { to: email, subject: "Please verify your email address" },
              template: "verify_email.mjml",
              variables: {
                token,
                verifyLink: `${yield* rootUrl}/verify#token=${token}`,
                username: marker,
                name: null,
              },
            },
          ]);
        }),
      ),
    );

    it.effect("does not mail a verification token that a newer one replaced", () =>
      withUsers("stale", (marker) =>
        Effect.gen(function* () {
          const { email } = yield* createUser(marker, false);
          const db = yield* PgRootDB;
          const { id } = yield* db.one(
            db.connection
              .selectFrom("app_public.user_emails")
              .select("id")
              .where("email", "=", email),
          );
          const [job] = yield* queuedOnce(SendVerification, "user_emails__send_verification", id);
          yield* db.all(
            db.connection
              .updateTable("app_private.user_email_secrets")
              .set({
                verification_token_hash: sql`app_private.hash_token(encode(gen_random_bytes(32), 'hex'))`,
              })
              .where("user_email_id", "=", id),
          );
          yield* (yield* AccountMail).sendVerification(job.payload);
          expect(yield* queuedMail(marker)).toEqual([]);
        }),
      ),
    );

    it.effect("notices an address added later, not the one added with the account", () =>
      withUsers("audit", (marker) =>
        Effect.gen(function* () {
          const user = yield* createUser(marker, true);
          const db = yield* PgRootDB;
          const added = `${marker}_second@example.invalid`;
          yield* db.all(
            db.raw(
              sql`insert into app_public.user_emails (user_id, email) values (${user.id}, ${added})`,
            ),
          );
          const jobs = yield* queued("user__audit", marker);
          const events = yield* Effect.forEach(jobs, (job) =>
            Schema.decodeUnknownEffect(AuditEvent)(job.payload).pipe(
              Effect.map((event) => ({ event, queuedAt: job.created_at })),
            ),
          );
          expect(events.map(({ event }) => event.type)).toEqual(["added_email", "added_email"]);
          const mail = yield* AccountMail;
          yield* Effect.forEach(events, ({ event, queuedAt }) => mail.audit(event, queuedAt));
          expect(yield* queuedMail(marker)).toEqual([
            {
              options: {
                to: [user.email],
                subject: `[${packageJson.projectName}] You added an email to your account`,
              },
              template: "account_activity.mjml",
              variables: {
                actionDescription: `You added the email '${added}' to your account.`,
              },
            },
          ]);
        }),
      ),
    );

    it.effect("notices a provider account linked by its verified email", () =>
      withUsers("link", (marker) =>
        Effect.gen(function* () {
          const user = yield* createUser(marker, true);
          const identifier = `${marker}_gh`;
          const db = yield* PgRootDB;
          yield* db.all(
            db.raw(
              sql`select app_private.link_or_register_user(null, 'github', ${identifier}, json_build_object('email', ${user.email}::text), '{}'::json)`,
            ),
          );
          const [job] = yield* queuedOnce(AuditEvent, "user__audit", identifier);
          const mail = yield* AccountMail;
          yield* mail.audit(job.payload, job.created_at);
          expect(yield* queuedMail(marker)).toEqual([
            {
              options: {
                to: [user.email],
                subject: `[${packageJson.projectName}] You linked a third-party OAuth provider to your account`,
              },
              template: "account_activity.mjml",
              variables: {
                actionDescription:
                  "You linked a third-party OAuth provider ('github') to your account.",
              },
            },
          ]);
        }),
      ),
    );

    it.effect("mails a reset link to a known address, and a notice to an unknown one", () =>
      withUsers("reset", (marker) =>
        Effect.gen(function* () {
          const user = yield* createUser(marker, true);
          const unknown = `${marker}_none@example.invalid`;
          const db = yield* PgRootDB;
          yield* db.all(db.raw(sql`select app_public.forgot_password(${user.email}::citext)`));
          yield* db.all(db.raw(sql`select app_public.forgot_password(${unknown}::citext)`));
          const [reset] = yield* queuedOnce(ForgotPassword, "user__forgot_password", user.email);
          const [notice] = yield* queuedOnce(
            ForgotPasswordUnregistered,
            "user__forgot_password_unregistered_email",
            unknown,
          );
          const mail = yield* AccountMail;
          yield* mail.forgotPassword(reset.payload);
          yield* mail.forgotPasswordUnregistered(notice.payload);
          const root = yield* rootUrl;
          const { token } = reset.payload;
          expect(yield* queuedMail(marker)).toEqual([
            {
              options: { to: user.email, subject: "Password reset" },
              template: "password_reset.mjml",
              variables: {
                token,
                verifyLink: `${root}/reset#token=${token}`,
              },
            },
            {
              options: {
                to: unknown,
                subject: `Password reset request failed: you don't have a ${packageJson.projectName} account`,
              },
              template: "password_reset_unregistered.mjml",
              variables: { url: root },
            },
          ]);
        }),
      ),
    );
  },
);

/**
 * Runs `test` with a marker unique to this test, which names its users and
 * addresses, and removes those users and their jobs afterwards.
 */
const withUsers = <A, E>(
  name: string,
  test: (marker: string) => Effect.Effect<A, E, AccountMail | PgRootDB>,
) =>
  Effect.flatMap(randomSuffix, (suffix) => {
    const marker = `${name}_${suffix}`;
    return test(marker).pipe(Effect.ensuring(cleanUp(marker).pipe(Effect.orDie)));
  });

const createUser = Effect.fn(function* (name: string, verified: boolean) {
  const db = yield* PgRootDB;
  const email = `${name}@example.invalid`;
  const { id } = yield* db.one(
    db.raw(
      sql<{
        id: string;
      }>`select id from app_private.really_create_user(
        username => ${name}::citext,
        email => ${email}::text,
        email_is_verified => ${verified},
        password => ${"TestPassword123!"}::text
      )`,
    ),
  );
  return { id, email };
});

/** The jobs queued for `task` whose payload mentions `text`, oldest first. */
const queued = Effect.fn(function* (task: string, text: string) {
  const db = yield* PgRootDB;
  return yield* db.all(
    db.raw(sql<{ payload: unknown; created_at: Date }>`
      select j.payload, j.created_at
      from graphile_worker._private_jobs j
      join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = ${task} and j.payload::text like ${`%${text}%`}
      order by j.id`),
  );
});

/** The one job queued for `task` that mentions `text`, decoded as the worker decodes it. */
const queuedOnce = Effect.fn(function* <P extends Schema.Decoder<unknown>>(
  payload: P,
  task: string,
  text: string,
) {
  const jobs = yield* queued(task, text);
  return yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ payload, created_at: Schema.Date })]),
  )(jobs);
});

const queuedMail = Effect.fn(function* (marker: string) {
  const jobs = yield* queued("send_email", marker);
  return yield* Effect.forEach(jobs, (job) => Schema.decodeUnknownEffect(QueuedEmail)(job.payload));
});

const cleanUp = Effect.fn(function* (marker: string) {
  const db = yield* PgRootDB;
  const like = `%${marker}%`;
  yield* db.all(
    db.raw(sql`
      delete from graphile_worker._private_jobs
      where payload::text like ${like}
        or payload->>'id' in (select id::text from app_public.user_emails where email like ${like})`),
  );
  yield* db.all(db.raw(sql`delete from app_public.users where username like ${like}`));
});
