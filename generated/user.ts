import { Model } from "@effect/sql";
import { Schema as S } from "effect";
import { UserRole } from "./userRole.js";

export class User extends Model.Class<User>("users")({
  id: Model.Generated(S.UUID),
  username: S.String,
  name: S.NullOr(S.String),
  avatar_url: S.NullOr(S.String),
  bio: S.String,
  role: UserRole,
  is_verified: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
