import { Schema as S } from "effect";
import { Model } from "@effect/sql";

export const OrganizationInvitationInsert = S.Struct({
  id: S.UUID,
  organization_id: S.UUID,
  code: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  email: S.String.pipe(S.NullOr),
});

export type OrganizationInvitationInsertType = S.Schema.Type<typeof OrganizationInvitationInsert>;

export const OrganizationInvitationUpdate = S.Struct({
  id: S.UUID,
  organization_id: S.UUID,
  code: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  email: S.String.pipe(S.NullOr),
});

export type OrganizationInvitationUpdateType = S.Schema.Type<typeof OrganizationInvitationUpdate>;

export class OrganizationInvitation extends Model.Class<OrganizationInvitation>("organization_invitations")({
  id: Model.Generated(S.UUID),
  organization_id: S.UUID,
  code: S.String.pipe(S.NullOr),
  user_id: S.UUID.pipe(S.NullOr),
  email: S.String.pipe(S.NullOr),
}) {}