import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const SessionInsert = S.Struct({
  id: S.String,
  user_id: S.UUID,
  session_data: S.Unknown,
  secret_hash: S.Unknown.pipe(S.NullOr),
  created_at: S.DateFromSelf,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
});

export type SessionInsertType = S.Schema.Type<typeof SessionInsert>;

export const SessionUpdate = S.Struct({
  id: S.String,
  user_id: S.UUID,
  session_data: S.Unknown,
  secret_hash: S.Unknown.pipe(S.NullOr),
  created_at: S.DateFromSelf,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
});

export type SessionUpdateType = S.Schema.Type<typeof SessionUpdate>;

export class Session extends Model.Class<Session>("sessions")({
  id: S.String,
  user_id: S.UUID,
  session_data: S.Unknown,
  secret_hash: S.Unknown.pipe(S.NullOr),
  created_at: Model.DateTimeInsertFromDate,
  expires_at: S.DateFromSelf.pipe(S.NullOr),
}) {}