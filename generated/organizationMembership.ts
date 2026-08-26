import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class OrganizationMembership extends Model.Class<OrganizationMembership>(
  "organization_memberships",
)({
  id: Model.Generated(S.UUID),
  organization_id: S.UUID,
  user_id: S.UUID,
  is_owner: S.Boolean,
  is_billing_contact: S.Boolean,
  created_at: Model.DateTimeInsertFromDate,
}) {}
