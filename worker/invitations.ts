import type { LoadedInvitation } from "@danielfgray/stompbox/mail";
import { Context, Effect, Layer, Option } from "effect";

import { PgRootDB } from "../server/db.js";

/**
 * Reads an organization invitation for its mail task. Runs as the owner role:
 * the worker has no visitor, and the invitation is read before anyone can
 * accept it.
 */
export class Invitations extends Context.Service<Invitations>()("postgres-garden/invitations", {
  make: Effect.gen(function* () {
    const db = yield* PgRootDB;

    return {
      /**
       * None when the invitation is gone. An invitation to an address carries
       * its code. An invitation to a user has none: the account's login proves
       * the reader, and the mail goes to the user's first verified address.
       * The table does not record who invited, so `inviterName` is none.
       */
      load: Effect.fn("Invitations.load")(function* (id: string) {
        const invitation = yield* db.maybe(
          db.connection
            .selectFrom("app_public.organization_invitations as invitation")
            .innerJoin(
              "app_public.organizations as organization",
              "organization.id",
              "invitation.organization_id",
            )
            .select([
              "invitation.email",
              "invitation.code",
              "invitation.user_id",
              "organization.name",
            ])
            .where("invitation.id", "=", id),
        );
        if (Option.isNone(invitation)) return Option.none<LoadedInvitation>();
        const { email, code, user_id, name } = invitation.value;
        const address = email
          ? Option.some(email)
          : user_id
            ? yield* db
                .maybe(
                  db.connection
                    .selectFrom("app_public.user_emails")
                    .select("email")
                    .where("user_id", "=", user_id)
                    .where("is_verified", "=", true)
                    .orderBy("id", "asc")
                    .limit(1),
                )
                .pipe(Effect.map(Option.map((row) => row.email)))
            : Option.none<string>();
        return Option.some<LoadedInvitation>({
          email: address,
          code: Option.fromNullishOr(code),
          groupName: name,
          inviterName: Option.none(),
        });
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(PgRootDB.layer));
}
