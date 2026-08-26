import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class PlaygroundStar extends Model.Class<PlaygroundStar>("playground_stars")({
  playground_hash: S.String,
  user_id: Model.Generated(S.UUID),
  created_at: Model.DateTimeInsertFromDate,
}) {}
