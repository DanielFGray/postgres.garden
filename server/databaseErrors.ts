import { Forbidden, NotFound, Unauthorized } from "@danielfgray/stompbox/http";
import { DatabaseAnswers } from "@danielfgray/stompbox/http/server";

import {
  AccountAlreadyLinked,
  AlreadyMember,
  BadCredentials,
  CannotDeleteLastEmail,
  EmailNotVerified,
  EmailTaken,
  Locked,
  MissingData,
  OwnsOrganization,
  PasswordTooWeak,
  SlugTaken,
  StaleBasis,
  UsernameTaken,
} from "../shared/errors.js";

/**
 * What a database refusal means to a client, beyond stompbox's standard
 * answers (stompbox `docs/http/design.md`).
 *
 * - `codes`: custom SQLSTATEs that the SQL functions in migrations/ raise. Each
 *   one's message is written for users, so the answer carries it.
 * - `constraints`: unique constraints a user can hit, by the name Postgres
 *   reports.
 */
export const toHttpError = DatabaseAnswers.make({
  codes: {
    CREDS: (message) => new BadCredentials({ message }),
    LOGIN: (message) => new Unauthorized({ message }),
    LOCKD: (message) => new Locked({ message }),
    DNIED: (message) => new Forbidden({ message, reason: "access_denied" }),
    NTFND: (message) => new NotFound({ message }),
    WEAKP: (message) => new PasswordTooWeak({ message }),
    MODAT: (message) => new MissingData({ message }),
    CDLEA: (message) => new CannotDeleteLastEmail({ message }),
    VRFY1: (message) => new EmailNotVerified({ message }),
    VRFY2: (message) => new EmailNotVerified({ message }),
    TAKEN: (message) => new AccountAlreadyLinked({ message }),
    EMTKN: (message) => new EmailTaken({ message }),
    ISMBR: (message) => new AlreadyMember({ message }),
    OWNER: (message) => new OwnsOrganization({ message }),
    STALE: (message) => new StaleBasis({ message }),
  },
  constraints: {
    users_username_key: new UsernameTaken({ message: "That username is already taken." }),
    uniq_user_emails_verified_email: new EmailTaken({
      message: "That email address is already in use.",
    }),
    user_emails_user_id_email_key: new EmailTaken({
      message: "That email address is already on your account.",
    }),
    organizations_slug_key: new SlugTaken({ message: "That slug is already in use." }),
  },
});
