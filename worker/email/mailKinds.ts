import { EmailDelivery, invitationMail, mailKind } from "@danielfgray/stompbox/mail";
import { Effect, Layer, Path, Schema } from "effect";

import packageJson from "../../package.json" with { type: "json" };

/**
 * The app's mail kinds: each names an MJML file in `worker/templates/` and the
 * variables that file reads. `accountMail.ts` queues these as `send_email` jobs.
 */
export const verifyEmail = mailKind("verify_email.mjml", {
  token: Schema.String,
  verifyLink: Schema.String,
  username: Schema.String,
  name: Schema.NullOr(Schema.String),
});

export const passwordReset = mailKind("password_reset.mjml", {
  token: Schema.String,
  verifyLink: Schema.String,
});

export const deleteAccount = mailKind("delete_account.mjml", {
  token: Schema.String,
  deleteAccountLink: Schema.String,
});

export const passwordResetUnregistered = mailKind("password_reset_unregistered.mjml", {
  url: Schema.String,
});

/** A security notice: exempt from the per-address cap. */
export const accountActivity = mailKind(
  "account_activity.mjml",
  { actionDescription: Schema.String },
  { notice: true },
);

/** The payload of a `send_email` job. */
export const QueuedEmail = Schema.Union([
  verifyEmail.schema,
  passwordReset.schema,
  deleteAccount.schema,
  passwordResetUnregistered.schema,
  accountActivity.schema,
]);
export type QueuedEmail = typeof QueuedEmail.Type;

/**
 * Renders the kinds above and the invitation. Templates resolve from this
 * module, so they sit beside `worker/` in the source tree and the image.
 */
export const EmailDeliveryLive = Layer.unwrap(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return EmailDelivery.layer({
      kinds: [
        verifyEmail,
        passwordReset,
        deleteAccount,
        passwordResetUnregistered,
        accountActivity,
        invitationMail,
      ],
      templates: yield* path.fromFileUrl(new URL("../templates/", import.meta.url)),
      brand: { projectName: packageJson.projectName, legalText: packageJson.legalText },
    });
  }),
);
