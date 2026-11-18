import { Schema as S } from "effect";

import { Privacy, User, UserEmail } from "../shared/schemas.js";

/**
 * The shapes of the rows the services select, as the driver returns them
 * (`Date` for a timestamp, `bigint` for an int8). The runner of
 * `@danielfgray/stompbox/db` decodes each query's rows with one of these, and a
 * query whose columns do not fit its schema does not compile.
 */

/** A row of `app_public.users`. */
export const UserRow = S.toType(User);

/** A row of `app_public.user_emails`. */
export const UserEmailRow = S.toType(UserEmail);

/**
 * A commit with the head of its playground, which says whether the commit is
 * the newest. `data` is the JSON the commit functions store; the caller decodes
 * it, because it is the only column whose shape the database does not fix.
 */
export const CommitRow = S.Struct({
  id: S.String,
  message: S.String,
  data: S.Unknown,
  created_at: S.Date,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  head_commit_id: S.NullOr(S.String),
});

/**
 * The columns of `app_public.playgrounds` that leave the server. The row also
 * holds the digest of the edit key, which no query selects into a result.
 */
export const playgroundFields = {
  hash: S.String,
  head_commit_id: S.NullOr(S.String),
  user_id: S.NullOr(S.String),
  fork_hash: S.NullOr(S.String),
  privacy: Privacy,
  created_at: S.Date,
  updated_at: S.Date,
  name: S.NullOr(S.String),
  description: S.NullOr(S.String),
  data_size: S.BigInt,
  expires_at: S.NullOr(S.Date),
};

export const PlaygroundRow = S.Struct(playgroundFields);
