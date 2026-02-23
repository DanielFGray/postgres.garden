import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const PlaygroundCommentInsert = S.Struct({
  id: S.Number,
  user_id: S.UUID,
  playground_hash: S.String,
  body: S.String,
  range: S.Unknown.pipe(S.NullOr),
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type PlaygroundCommentInsertType = S.Schema.Type<typeof PlaygroundCommentInsert>;

export const PlaygroundCommentUpdate = S.Struct({
  id: S.Number,
  user_id: S.UUID,
  playground_hash: S.String,
  body: S.String,
  range: S.Unknown.pipe(S.NullOr),
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
});

export type PlaygroundCommentUpdateType = S.Schema.Type<typeof PlaygroundCommentUpdate>;

export class PlaygroundComment extends Model.Class<PlaygroundComment>("playground_comments")({
  id: Model.Generated(S.Number),
  user_id: S.UUID,
  playground_hash: S.String,
  body: S.String,
  range: S.Unknown.pipe(S.NullOr),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}