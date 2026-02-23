import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const PlaygroundStarInsert = S.Struct({
  playground_hash: S.String,
  user_id: S.UUID,
  created_at: S.DateFromSelf,
});

export type PlaygroundStarInsertType = S.Schema.Type<typeof PlaygroundStarInsert>;

export const PlaygroundStarUpdate = S.Struct({
  playground_hash: S.String,
  user_id: S.UUID,
  created_at: S.DateFromSelf,
});

export type PlaygroundStarUpdateType = S.Schema.Type<typeof PlaygroundStarUpdate>;

export class PlaygroundStar extends Model.Class<PlaygroundStar>("playground_stars")({
  playground_hash: S.String,
  user_id: Model.Generated(S.UUID),
  created_at: Model.DateTimeInsertFromDate,
}) {}