import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const OrganizationInsert = S.Struct({
  id: S.UUID,
  slug: S.String,
  name: S.String,
  description: S.String.pipe(S.NullOr),
  created_at: S.DateFromSelf,
});

export type OrganizationInsertType = S.Schema.Type<typeof OrganizationInsert>;

export const OrganizationUpdate = S.Struct({
  id: S.UUID,
  slug: S.String,
  name: S.String,
  description: S.String.pipe(S.NullOr),
  created_at: S.DateFromSelf,
});

export type OrganizationUpdateType = S.Schema.Type<typeof OrganizationUpdate>;

export class Organization extends Model.Class<Organization>("organizations")({
  id: Model.Generated(S.UUID),
  slug: S.String,
  name: S.String,
  description: S.String.pipe(S.NullOr),
  created_at: Model.DateTimeInsertFromDate,
}) {}