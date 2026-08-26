import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class PlaygroundCommit extends Model.Class<PlaygroundCommit>("playground_commits")({
  id: Model.Generated(S.String),
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  user_id: S.NullOr(S.UUID),
  message: S.String,
  data: S.Unknown,
  created_at: Model.DateTimeInsertFromDate,
}) {}
