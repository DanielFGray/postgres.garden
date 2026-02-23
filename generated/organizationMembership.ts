import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const OrganizationMembershipInsert = S.Struct({
  id: S.UUID,
  organization_id: S.UUID,
  user_id: S.UUID,
  is_owner: S.Boolean,
  is_billing_contact: S.Boolean,
  created_at: S.DateFromSelf,
});

export type OrganizationMembershipInsertType = S.Schema.Type<typeof OrganizationMembershipInsert>;

export const OrganizationMembershipUpdate = S.Struct({
  id: S.UUID,
  organization_id: S.UUID,
  user_id: S.UUID,
  is_owner: S.Boolean,
  is_billing_contact: S.Boolean,
  created_at: S.DateFromSelf,
});

export type OrganizationMembershipUpdateType = S.Schema.Type<typeof OrganizationMembershipUpdate>;

export class OrganizationMembership extends Model.Class<OrganizationMembership>("organization_memberships")({
  id: Model.Generated(S.UUID),
  organization_id: S.UUID,
  user_id: S.UUID,
  is_owner: S.Boolean,
  is_billing_contact: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
}) {}