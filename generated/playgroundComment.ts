import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class PlaygroundComment extends Model.Class<PlaygroundComment>("playground_comments")({
  id: Model.Generated(S.Number),
  user_id: S.UUID,
  playground_hash: S.String,
  body: S.String,
  range: S.NullOr(S.Unknown),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
