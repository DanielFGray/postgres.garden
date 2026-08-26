import { Model } from "@effect/sql";
import { Schema as S } from "effect";
import { Privacy } from "./privacy.js";

export class Playground extends Model.Class<Playground>("playgrounds")({
  hash: S.String,
  user_id: S.NullOr(S.UUID),
  fork_hash: S.NullOr(S.String),
  privacy: Privacy,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
  name: S.NullOr(S.String),
  description: S.NullOr(S.String),
  data_size: S.BigInt,
  expires_at: S.NullOr(S.DateFromSelf),
}) {}
