import { Schema as S } from "effect";
import { Model } from "@effect/sql";
import { Privacy } from "./privacy.js";

export const PlaygroundInsert = S.Struct({
  hash: S.String,
  user_id: S.UUID.pipe(S.NullOr),
  fork_hash: S.String.pipe(S.NullOr),
  privacy: Privacy.pipe(S.optional),
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
  name: S.String.pipe(S.pattern(/^[a-zA-Z0-9_-]+$/), S.NullOr),
  description: S.String.pipe(S.NullOr),
  data_size: S.BigInt,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
});

export type PlaygroundInsertType = S.Schema.Type<typeof PlaygroundInsert>;

export const PlaygroundUpdate = S.Struct({
  hash: S.String,
  user_id: S.UUID.pipe(S.NullOr),
  fork_hash: S.String.pipe(S.NullOr),
  privacy: Privacy.pipe(S.optional),
  created_at: S.DateFromSelf,
  updated_at: S.DateFromSelf,
  name: S.String.pipe(S.pattern(/^[a-zA-Z0-9_-]+$/), S.NullOr),
  description: S.String.pipe(S.NullOr),
  data_size: S.BigInt,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
});

export type PlaygroundUpdateType = S.Schema.Type<typeof PlaygroundUpdate>;

export class Playground extends Model.Class<Playground>("playgrounds")({
  hash: S.String,
  user_id: S.UUID.pipe(S.NullOr),
  fork_hash: S.String.pipe(S.NullOr),
  privacy: Privacy,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
  name: S.String.pipe(S.NullOr),
  description: S.String.pipe(S.NullOr),
  data_size: S.BigInt,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
}) {}