import { Context, Effect, Layer, Match, Option, Schema } from "effect";

import { PgRootDB } from "../server/db.js";

/**
 * Gives a GitHub sponsor the sponsor role, and takes it back when the
 * sponsorship ends. `WebhookService` verifies GitHub's sponsorship event and
 * queues its body as the `sponsor_webhook` job.
 *
 * Only the user and sponsor roles change: an admin or pro account that also
 * sponsors keeps its role.
 */
export class Sponsorship extends Context.Service<Sponsorship>()("Worker/Sponsorship", {
  make: Effect.gen(function* () {
    const db = yield* PgRootDB;

    const setRole = (userId: string, from: "user" | "sponsor", to: "user" | "sponsor") =>
      db.all(
        db.connection
          .updateTable("app_public.users")
          .set({ role: to })
          .where("id", "=", userId)
          .where("role", "=", from),
      );

    return {
      apply: Effect.fn("Sponsorship.apply")(function* ({ action, sponsorship }: SponsorshipEvent) {
        if (Option.isNone(sponsorship.sponsor)) {
          return yield* Effect.logWarning(`The sponsorship event (${action}) names no sponsor`);
        }
        const { login } = sponsorship.sponsor.value;
        const account = yield* db.maybe(
          db.connection
            .selectFrom("app_public.user_authentications")
            .select("user_id")
            .where("service", "=", "github")
            .where("identifier", "=", login)
            .limit(1),
        );
        if (Option.isNone(account)) {
          return yield* Effect.logWarning(`No user has the GitHub login ${login}`);
        }
        const userId = account.value.user_id;
        return yield* Match.value(action).pipe(
          Match.whenOr("created", "tier_changed", () =>
            setRole(userId, "user", "sponsor").pipe(
              Effect.andThen(Effect.logInfo(`User ${userId} (${login}) is a sponsor`)),
            ),
          ),
          Match.when("cancelled", () =>
            setRole(userId, "sponsor", "user").pipe(
              Effect.andThen(Effect.logInfo(`User ${userId} (${login}) is no longer a sponsor`)),
            ),
          ),
          Match.orElse(() => Effect.void),
        );
      }),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/**
 * The fields of GitHub's `sponsorship` webhook event that the job reads. The
 * action stays open: an action GitHub adds later changes no role.
 */
export const SponsorshipEvent = Schema.Struct({
  action: Schema.String,
  sponsorship: Schema.Struct({
    // GitHub's own event type allows a null sponsor.
    sponsor: Schema.OptionFromNullOr(Schema.Struct({ login: Schema.NonEmptyString })),
  }),
});
export type SponsorshipEvent = typeof SponsorshipEvent.Type;
