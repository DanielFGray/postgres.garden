import { Schema as S } from "effect";

/**
 * The classes this app adds to the generic ones in `@danielfgray/stompbox/http`.
 * Each is one refusal with its own status, so a client tells them apart by
 * `_tag`. The ones that a failed database call or a handler answers with are
 * listed in `refusals`, which `FailureBoundary` declares.
 */

/** No account matches the username or email and the password. */
export class BadCredentials extends S.TaggedError<
  BadCredentials,
  { readonly brand: unique symbol }
>()("BadCredentials", { message: S.String }, { httpApiStatus: 401 }) {}

/** The account is locked after too many failed attempts. */
export class Locked extends S.TaggedError<Locked, { readonly brand: unique symbol }>()(
  "Locked",
  { message: S.String },
  { httpApiStatus: 423 },
) {}

/** Another account has the username. */
export class UsernameTaken extends S.TaggedError<
  UsernameTaken,
  { readonly brand: unique symbol }
>()("UsernameTaken", { message: S.String }, { httpApiStatus: 409 }) {}

/** Another account, or this one, has the email address. */
export class EmailTaken extends S.TaggedError<EmailTaken, { readonly brand: unique symbol }>()(
  "EmailTaken",
  { message: S.String },
  { httpApiStatus: 409 },
) {}

/** The person is already a member of the organization. */
export class AlreadyMember extends S.TaggedError<
  AlreadyMember,
  { readonly brand: unique symbol }
>()("AlreadyMember", { message: S.String }, { httpApiStatus: 409 }) {}

/** A different user already has the third-party account linked. */
export class AccountAlreadyLinked extends S.TaggedError<
  AccountAlreadyLinked,
  { readonly brand: unique symbol }
>()("AccountAlreadyLinked", { message: S.String }, { httpApiStatus: 409 }) {}

/** The user owns an organization, which blocks deleting the account. */
export class OwnsOrganization extends S.TaggedError<
  OwnsOrganization,
  { readonly brand: unique symbol }
>()("OwnsOrganization", { message: S.String }, { httpApiStatus: 409 }) {}

/** Another organization has the slug. */
export class SlugTaken extends S.TaggedError<SlugTaken, { readonly brand: unique symbol }>()(
  "SlugTaken",
  { message: S.String },
  { httpApiStatus: 409 },
) {}

/** A save was made from a commit that is no longer the playground's head. */
export class StaleBasis extends S.TaggedError<StaleBasis, { readonly brand: unique symbol }>()(
  "StaleBasis",
  { message: S.String },
  { httpApiStatus: 409 },
) {}

/** The password fails the database's strength rule. */
export class PasswordTooWeak extends S.TaggedError<
  PasswordTooWeak,
  { readonly brand: unique symbol }
>()("PasswordTooWeak", { message: S.String }, { httpApiStatus: 400 }) {}

/** The request leaves out data the database needs. */
export class MissingData extends S.TaggedError<MissingData, { readonly brand: unique symbol }>()(
  "MissingData",
  { message: S.String },
  { httpApiStatus: 400 },
) {}

/** The account must keep at least one email address. */
export class CannotDeleteLastEmail extends S.TaggedError<
  CannotDeleteLastEmail,
  { readonly brand: unique symbol }
>()("CannotDeleteLastEmail", { message: S.String }, { httpApiStatus: 400 }) {}

/** The email address is not verified yet. */
export class EmailNotVerified extends S.TaggedError<
  EmailNotVerified,
  { readonly brand: unique symbol }
>()("EmailNotVerified", { message: S.String }, { httpApiStatus: 400 }) {}

/** The caller went over a rate limit, or the limit store is down on an endpoint that refuses then. */
export class TooManyRequests extends S.TaggedError<
  TooManyRequests,
  { readonly brand: unique symbol }
>()("TooManyRequests", { message: S.String, retryAfterSeconds: S.Int }, { httpApiStatus: 429 }) {}

/** Every refusal that a failed database call or a handler answers with. */
export const refusals = [
  BadCredentials,
  Locked,
  UsernameTaken,
  EmailTaken,
  AlreadyMember,
  AccountAlreadyLinked,
  OwnsOrganization,
  SlugTaken,
  StaleBasis,
  PasswordTooWeak,
  MissingData,
  CannotDeleteLastEmail,
  EmailNotVerified,
] as const;
