import { Array as Arr, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { RateLimiter } from "effect/persistence/RateLimiter";
import { convert } from "html-to-text";
import template from "lodash.template";
import mjml from "mjml";

import packageJson from "../../package.json" with { type: "json" };
import { storeTimeout } from "../../server/services/rateLimiter.js";
import { Mailer, MailMessage } from "./mailer.js";

const options = Schema.Struct({
  to: Schema.Union([Schema.NonEmptyString, Schema.NonEmptyArray(Schema.NonEmptyString)]),
  subject: Schema.String,
});

export const QueuedEmail = Schema.Union([
  Schema.Struct({
    options,
    template: Schema.Literal("verify_email.mjml"),
    variables: Schema.Struct({
      token: Schema.String,
      verifyLink: Schema.String,
      username: Schema.String,
      name: Schema.NullOr(Schema.String),
    }),
  }),
  Schema.Struct({
    options,
    template: Schema.Literal("password_reset.mjml"),
    variables: Schema.Struct({
      token: Schema.String,
      verifyLink: Schema.String,
    }),
  }),
  Schema.Struct({
    options,
    template: Schema.Literal("delete_account.mjml"),
    variables: Schema.Struct({
      token: Schema.String,
      deleteAccountLink: Schema.String,
    }),
  }),
  Schema.Struct({
    options,
    template: Schema.Literal("password_reset_unregistered.mjml"),
    variables: Schema.Struct({ url: Schema.String }),
  }),
  Schema.Struct({
    options,
    template: Schema.Literal("account_activity.mjml"),
    variables: Schema.Struct({ actionDescription: Schema.String }),
  }),
]);
export type QueuedEmail = typeof QueuedEmail.Type;

export class EmailRenderError extends Schema.TaggedError<
  EmailRenderError,
  { readonly brand: unique symbol }
>()("EmailRenderError", {
  template: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * Render one queued job's MJML template, and require delivery from
 * Mailer. SMTP rejection fails the job so graphile-worker retries it.
 * A recipient over the per-address cap is dropped with a warning, and the job
 * still succeeds: a failed job would be retried and the mail sent later anyway.
 * When the cap cannot be checked, the job fails so that graphile-worker retries it.
 */
export const sendEmail = Effect.fn("sendEmail")(function* (job: QueuedEmail) {
  const recipients = yield* withinCap(job);
  if (!Arr.isReadonlyArrayNonEmpty(recipients)) return;
  const fs = yield* FileSystem;
  const path = yield* Path;
  // From the working directory: the production server is one bundle in
  // `dist/`, so a path relative to this module would point there.
  const source = yield* fs.readFileString(path.resolve("worker/templates", job.template));
  const rendered = yield* Effect.tryPromise({
    try: () =>
      mjml(
        template(source, { escape: /\[\[([\s\S]+?)\]\]/g })({
          projectName: packageJson.projectName,
          legalText: packageJson.legalText,
          ...job.variables,
        }),
        { validationLevel: "strict" },
      ),
    catch: (cause) => new EmailRenderError({ template: job.template, cause }),
  });
  if (rendered.errors.length > 0) {
    return yield* new EmailRenderError({
      template: job.template,
      cause: rendered.errors.map((error) => error.formattedMessage).join("\n"),
    });
  }
  const html = rendered.html;
  const text = convert(html.replace(/(<\/?)div/g, "$1p"), { wordwrap: 120 }).replace(
    /\n\s+\n/g,
    "\n\n",
  );
  const mailer = yield* Mailer;
  yield* mailer.send(
    new MailMessage({
      to: recipients,
      subject: job.options.subject,
      html,
      text,
    }),
  );
});

/**
 * Mail to one address per hour, across every kind of mail, so that requests
 * from many networks cannot flood one inbox. The API's per-caller limits
 * cannot see that case.
 */
const PER_ADDRESS_LIMIT = 5;
const PER_ADDRESS_WINDOW = "1 hour";

/**
 * Security notices are exempt. Only an action on the account sends one, and a
 * flood that used up the cap first would otherwise hide the notice of the attack.
 */
const uncapped: ReadonlySet<QueuedEmail["template"]> = new Set(["account_activity.mjml"]);

/** The job's recipients that are still under the per-address cap. */
const withinCap = Effect.fnUntraced(function* (job: QueuedEmail) {
  const to = typeof job.options.to === "string" ? [job.options.to] : job.options.to;
  if (uncapped.has(job.template)) return to;
  const limiter = yield* RateLimiter;
  return yield* Effect.filter(to, (address) =>
    limiter
      .consume({
        key: `recipient:${address.toLowerCase()}`,
        limit: PER_ADDRESS_LIMIT,
        window: PER_ADDRESS_WINDOW,
        onExceeded: "fail",
      })
      .pipe(
        Effect.timeout(storeTimeout),
        Effect.as(true),
        Effect.catchReason("RateLimiterError", "RateLimitExceeded", () =>
          Effect.logWarning(
            `Dropped ${job.template}: ${address} is over ${PER_ADDRESS_LIMIT} mails per ${PER_ADDRESS_WINDOW}`,
          ).pipe(Effect.as(false)),
        ),
      ),
  );
});
