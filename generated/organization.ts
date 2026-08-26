import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class Organization extends Model.Class<Organization>("organizations")({
  id: Model.Generated(S.UUID),
  slug: S.String,
  name: S.String,
  description: S.NullOr(S.String),
  created_at: Model.DateTimeInsertFromDate,
}) {}
