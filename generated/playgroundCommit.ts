import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const PlaygroundCommitInsert = S.Struct({
  id: S.String,
  playground_hash: S.String,
  parent_id: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  message: S.String,
  data: S.Unknown,
  created_at: S.DateFromSelf,
});

export type PlaygroundCommitInsertType = S.Schema.Type<typeof PlaygroundCommitInsert>;

export const PlaygroundCommitUpdate = S.Struct({
  id: S.String,
  playground_hash: S.String,
  parent_id: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  message: S.String,
  data: S.Unknown,
  created_at: S.DateFromSelf,
});

export type PlaygroundCommitUpdateType = S.Schema.Type<typeof PlaygroundCommitUpdate>;

export class PlaygroundCommit extends Model.Class<PlaygroundCommit>("playground_commits")({
  id: Model.Generated(S.String),
  playground_hash: S.String,
  parent_id: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  message: S.String,
  data: S.Unknown,
  created_at: Model.DateTimeInsertFromDate,
}) {}