import { Model } from "@effect/sql";
import { Schema as S } from "effect";

export class OrganizationInvitation extends Model.Class<OrganizationInvitation>(
  "organization_invitations",
)({
  id: Model.Generated(S.UUID),
  organization_id: S.UUID,
  code: S.NullOr(S.String),
  user_id: S.NullOr(S.UUID),
  email: S.NullOr(S.String),
}) {}
