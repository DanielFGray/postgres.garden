import { EmailDelivery, invitationTask, MailCapture, Mailer } from "@danielfgray/stompbox/mail";
import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { sql } from "kysely";

import { rootUrl } from "../server/config.js";
import { PgRootDB } from "../server/db.js";
import { RateLimiterMemory } from "../server/services/rateLimiter.js";
import { createUser, randomSuffix } from "../server/testSupport.js";
import { EmailDeliveryLive } from "./email/mailKinds.js";
import { Invitations } from "./invitations.js";

/**
 * Each test inserts an invitation row, which queues its job as the trigger
 * does, then runs the job on the payload that trigger queued: `{ id }`. No
 * worker runs against the test database, so the queued job stays in the table.
 */
layer(
  Invitations.layer.pipe(
    Layer.provideMerge(PgRootDB.layer),
    Layer.provideMerge(EmailDeliveryLive),
    Layer.provideMerge(Mailer.layerCapture),
    Layer.provideMerge(MailCapture.layer),
    Layer.provideMerge(RateLimiterMemory),
    Layer.provideMerge(BunServices.layer),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("organization invitations", (it) => {
  it.effect("mails an address its code in the link's fragment", () =>
    withOrganization((organizationId, name) =>
      Effect.gen(function* () {
        const id = yield* insertInvitation(organizationId, {
          email: `${name}@example.invalid`,
          code: "invite-code",
        });
        yield* runTask(id);
        const [mail] = yield* sentTo(`${name}@example.invalid`);
        expect(mail?.to).toEqual([`${name}@example.invalid`]);
        expect(mail?.subject).toBe(`You have been invited to ${name}`);
        expect(mail?.html).toContain(
          `${yield* rootUrl}/invitations/accept?id=${id}#token=invite-code`,
        );
      }),
    ),
  );

  it.effect("mails a user at a verified address with no code in the link", () =>
    withOrganization((organizationId, name) =>
      Effect.gen(function* () {
        const db = yield* PgRootDB;
        const user = yield* createUser(db, `inv_${name}`);
        const id = yield* insertInvitation(organizationId, { user_id: user.id });
        yield* runTask(id);
        const [mail] = yield* sentTo(`inv_${name}@example.com`);
        expect(mail?.to).toEqual([`inv_${name}@example.com`]);
        expect(mail?.html).toContain(`${yield* rootUrl}/invitations/accept?id=${id}`);
        expect(mail?.html).not.toContain("#token=");
        yield* db.all(db.connection.deleteFrom("app_public.users").where("id", "=", user.id));
      }),
    ),
  );

  it.effect("sends nothing for an invitation that is gone", () =>
    Effect.gen(function* () {
      const before = (yield* sent).length;
      yield* runTask("00000000-0000-0000-0000-000000000000");
      expect(yield* sent).toHaveLength(before);
    }),
  );
});

const sent = MailCapture.use((capture) => capture.sent);

/** The mail to `address`: the layer is shared, so a test reads only its own. */
const sentTo = (address: string) =>
  Effect.map(sent, (mail) => mail.filter((message) => message.to.includes(address)));

/** Runs the invitation task as graphile-worker does, in the layer's context. */
const runTask = Effect.fnUntraced(function* (id: string) {
  const context = yield* Effect.context<EmailDelivery | Invitations>();
  const { load } = yield* Invitations;
  const task = invitationTask({
    job: "organization_invitations__send_invite",
    group: "organization",
    acceptPath: "/invitations/accept",
    rootUrl,
    load,
  })(context);
  yield* Effect.promise(() =>
    task(
      { id },
      {
        abortSignal: new AbortController().signal,
        job: {
          id: "1",
          task_identifier: "organization_invitations__send_invite",
          attempts: 1,
          created_at: DateTime.toDateUtc(DateTime.nowUnsafe()),
        },
      },
    ),
  );
});

const insertInvitation = Effect.fnUntraced(function* (
  organizationId: string,
  who: { readonly email: string; readonly code: string } | { readonly user_id: string },
) {
  const db = yield* PgRootDB;
  const row = yield* db.one(
    db.connection
      .insertInto("app_public.organization_invitations")
      .values({ organization_id: organizationId, ...who })
      .returning("id"),
  );
  return row.id;
});

/** Runs `test` with a fresh organization, removing it and its jobs afterwards. */
const withOrganization = <A, E, R>(
  test: (organizationId: string, name: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const db = yield* PgRootDB;
    const name = `inv_${yield* randomSuffix}`;
    const { id } = yield* db.one(
      db.connection
        .insertInto("app_public.organizations")
        .values({ slug: name, name })
        .returning("id"),
    );
    return yield* test(id, name).pipe(
      Effect.ensuring(
        db
          .all(
            db.raw(sql`
              delete from graphile_worker._private_jobs
              where payload->>'id' in (
                select id::text from app_public.organization_invitations
                where organization_id = ${id})`),
          )
          .pipe(
            Effect.andThen(
              db.all(db.connection.deleteFrom("app_public.organizations").where("id", "=", id)),
            ),
            Effect.orDie,
          ),
      ),
    );
  });
