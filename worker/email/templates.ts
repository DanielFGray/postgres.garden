import accountActivity from "../templates/account_activity.mjml" with { type: "text" };
import deleteAccount from "../templates/delete_account.mjml" with { type: "text" };
import invitation from "../templates/invitation.mjml" with { type: "text" };
import passwordReset from "../templates/password_reset.mjml" with { type: "text" };
import passwordResetUnregistered from "../templates/password_reset_unregistered.mjml" with { type: "text" };
import verifyEmail from "../templates/verify_email.mjml" with { type: "text" };

/**
 * The MJML sources, keyed by the file name each mail kind names. They are
 * imported as text so the bundle carries them: no path resolves at runtime.
 */
export const templates = {
  "account_activity.mjml": accountActivity,
  "delete_account.mjml": deleteAccount,
  "invitation.mjml": invitation,
  "password_reset.mjml": passwordReset,
  "password_reset_unregistered.mjml": passwordResetUnregistered,
  "verify_email.mjml": verifyEmail,
} as const;
