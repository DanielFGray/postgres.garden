import { expect, layer } from "@effect/vitest";
import type { DatabaseError } from "@danielfgray/stompbox/db";
import { Effect, Layer, Option, Random, Schema as S } from "effect";
import { sql } from "kysely";
import { DatabaseLive, type DB, type Queries } from "../db.js";
import { withRoot } from "../testSupport.js";
import { CurrentSession, type SessionData } from "../../shared/session.js";
import { withAuthContext } from "../requestDatabase.js";
import { Playgrounds } from "./playgrounds.js";
import { TestValkeyLive } from "../test/valkey.js";
import { Sessions } from "./sessions.js";

const TestLayer = Layer.mergeAll(Sessions.layer, Playgrounds.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(DatabaseLive, TestValkeyLive)),
);

/** No session at all: the anonymous visitor. */
const anonymousSession: SessionData = { user: null, session: null };

/** Unique enough to keep concurrent test users apart. */
const randomSuffix = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((n) => n.toString(16).padStart(8, "0")),
);

const playgroundHashes = (rows: ReadonlyArray<{ hash: string }>) =>
  rows.map(({ hash }) => hash).sort((a, b) => a.localeCompare(b));

const sortHashes = (hashes: ReadonlyArray<string>) =>
  [...hashes].sort((a, b) => a.localeCompare(b));

const fixtureHashes = (rows: ReadonlyArray<{ hash: string }>, fixtures: ReadonlySet<string>) =>
  playgroundHashes(rows.filter(({ hash }) => fixtures.has(hash)));

layer(TestLayer, { excludeTestServices: true, timeout: "30 seconds" })(
  "Playground visibility",
  (it) => {
    it.effect("applies visibility rules to browse, search, and profiles", () =>
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        const playgrounds = yield* Playgrounds;
        const suffix = yield* randomSuffix;
        const ownerUsername = `visibility_owner_${suffix}`;
        const otherUsername = `visibility_other_${suffix}`;
        // Sponsors, because these cases need a playground at every privacy level
        // and private is a sponsor entitlement.
        const users = yield* withRoot((rootDb) =>
          Effect.all([
            createUser(rootDb, ownerUsername, "sponsor"),
            createUser(rootDb, otherUsername, "sponsor"),
          ]),
        );
        const [owner, other] = users;
        const ownerHashes = yield* withRoot((rootDb) =>
          insertPlaygrounds(rootDb, owner.id, "owner", suffix),
        );
        const otherHashes = yield* withRoot((rootDb) =>
          insertPlaygrounds(rootDb, other.id, "other", suffix),
        );
        const hashes = { owner: ownerHashes, other: otherHashes };
        const fixtures = new Set(Object.values(hashes).flatMap((group) => Object.values(group)));

        yield* Effect.ensuring(
          Effect.gen(function* () {
            const ownerToken = yield* sessions.createSession(owner.id);
            const otherToken = yield* sessions.createSession(other.id);
            const ownerSession = yield* sessions.validateSessionToken(ownerToken.token);
            const otherSession = yield* sessions.validateSessionToken(otherToken.token);
            if (!ownerSession.session || !otherSession.session) {
              return yield* Effect.die(new Error("Failed to create test sessions"));
            }

            const anonymous = yield* listAll(
              playgrounds,
              anonymousSession,
              ownerUsername,
              fixtures,
            );
            const ownerView = yield* listAll(playgrounds, ownerSession, ownerUsername, fixtures);
            const otherView = yield* listAll(playgrounds, otherSession, ownerUsername, fixtures);

            expect(anonymous).toEqual({
              list: sortHashes([hashes.owner.public, hashes.other.public]),
              search: sortHashes([hashes.owner.public, hashes.other.public]),
              profile: sortHashes([hashes.owner.public]),
            });
            expect(ownerView).toEqual({
              list: sortHashes([hashes.owner.public, hashes.other.public]),
              search: sortHashes([
                hashes.owner.private,
                hashes.owner.secret,
                hashes.owner.public,
                hashes.other.public,
              ]),
              profile: sortHashes([hashes.owner.private, hashes.owner.secret, hashes.owner.public]),
            });
            expect(otherView).toEqual({
              list: sortHashes([hashes.owner.public, hashes.other.public]),
              search: sortHashes([
                hashes.owner.public,
                hashes.other.private,
                hashes.other.secret,
                hashes.other.public,
              ]),
              profile: sortHashes([hashes.owner.public]),
            });
          }),
          withRoot((rootDb) =>
            Effect.all([deleteUser(rootDb, owner.id), deleteUser(rootDb, other.id)]),
          ).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );

    // Playgrounds may have no owner, so the browse query left-joins users. The
    // list contract used to require a username, which made every anonymous
    // playground a 500 on /api/playgrounds.
    it.effect("lists an anonymous playground with a null user", () =>
      Effect.gen(function* () {
        const playgrounds = yield* Playgrounds;
        const hash = `anon_public_${yield* randomSuffix}`;

        yield* withRoot((rootDb) =>
          rootDb.exec((k) =>
            k
              .insertInto("app_public.playgrounds")
              .values({ hash, user_id: null, privacy: "public", name: hash }),
          ),
        );

        yield* Effect.ensuring(
          Effect.gen(function* () {
            const rows = yield* playgrounds.list({});
            const row = rows.find((candidate) => candidate.hash === hash);
            expect(row).toBeDefined();
            expect(row?.user).toBeNull();
          }).pipe(withAuthContext, Effect.provideService(CurrentSession, anonymousSession)),
          withRoot((rootDb) =>
            rootDb.exec((k) => k.deleteFrom("app_public.playgrounds").where("hash", "=", hash)),
          ).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );

    // Private is a paid entitlement. It cannot be enforced by RLS, because every
    // write path reaches the table through a SECURITY DEFINER function that
    // bypasses it, so a trigger is the only choke point. These cases write
    // directly as the table owner, which is the weakest position the rule has
    // to hold from.
    it.effect("rejects private playgrounds without a sponsor account", () =>
      Effect.gen(function* () {
        const suffix = yield* randomSuffix;
        const free = yield* withRoot((rootDb) =>
          createUser(rootDb, `privacy_free_${suffix}`, "user"),
        );
        const sponsor = yield* withRoot((rootDb) =>
          createUser(rootDb, `privacy_sponsor_${suffix}`, "sponsor"),
        );

        const insertPrivate = (userId: string | null, hash: string) =>
          withRoot((rootDb) =>
            rootDb.exec((k) =>
              k
                .insertInto("app_public.playgrounds")
                .values({ hash, user_id: userId, privacy: "private", name: hash }),
            ),
          );

        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* expectDenied(insertPrivate(free.id, `free_private_${suffix}`));
            yield* expectDenied(insertPrivate(null, `anon_private_${suffix}`));

            // A sponsor may hold one, and may not keep it after a downgrade.
            const sponsorHash = `sponsor_private_${suffix}`;
            yield* insertPrivate(sponsor.id, sponsorHash);
            yield* withRoot((rootDb) =>
              rootDb.exec((k) =>
                k
                  .updateTable("app_public.users")
                  .set({ role: "user" })
                  .where("id", "=", sponsor.id),
              ),
            );
            yield* expectDenied(
              withRoot((rootDb) =>
                rootDb.exec((k) =>
                  k
                    .updateTable("app_public.playgrounds")
                    .set({ privacy: "private" })
                    .where("hash", "=", sponsorHash),
                ),
              ),
            );
          }),
          withRoot((rootDb) =>
            Effect.all([deleteUser(rootDb, free.id), deleteUser(rootDb, sponsor.id)]),
          ).pipe(Effect.asVoid, Effect.orDie),
        );
      }),
    );
  },
);

/**
 * Assert an effect fails with the DNIED error code the entitlement trigger raises.
 * Flipping makes success the failure, so a write that goes through fails the test.
 */
const expectDenied = <A, R>(effect: Effect.Effect<A, DatabaseError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) =>
      expect(Option.map(error.report, (report) => report.code)).toEqual(Option.some("DNIED")),
    ),
  );

const createUser = (db: Queries<DB>, username: string, role: "user" | "sponsor") =>
  db
    .one(S.Struct({ id: S.String, username: S.String }), (k) =>
      k
        .selectFrom(
          sql<{ id: string; username: string }>`app_private.really_create_user(
        username => ${username}::citext,
        email => ${`${username}@example.com`}::text,
        email_is_verified => true,
        password => ${"TestPassword123!"}::text
      )`.as("user"),
        )
        .selectAll(),
    )
    .pipe(
      Effect.tap((user) =>
        db.exec((k) => k.updateTable("app_public.users").set({ role }).where("id", "=", user.id)),
      ),
    );

const insertPlaygrounds = Effect.fnUntraced(function* (
  db: Queries<DB>,
  userId: string,
  prefix: string,
  suffix: string,
) {
  const rows = {
    private: `${prefix}_private_${suffix}`,
    secret: `${prefix}_secret_${suffix}`,
    public: `${prefix}_public_${suffix}`,
  } as const;
  yield* db.exec((k) =>
    k.insertInto("app_public.playgrounds").values(
      Object.entries(rows).map(([privacy, hash]) => ({
        hash,
        user_id: userId,
        privacy: privacy as "private" | "secret" | "public",
        name: hash,
      })),
    ),
  );
  return rows;
});

const deleteUser = (db: Queries<DB>, userId: string) =>
  db.exec((k) => k.deleteFrom("app_public.users").where("id", "=", userId));

const listAll = (
  service: (typeof Playgrounds)["Service"],
  session: SessionData,
  username: string,
  fixtures: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const list = yield* service.list({ limit: 50 });
    const search = yield* service.search("", 50, 0);
    const profile = yield* service.listForUser(username, { limit: 50 });
    return {
      list: fixtureHashes(list, fixtures),
      search: fixtureHashes(search, fixtures),
      profile: fixtureHashes(profile, fixtures),
    };
  }).pipe(withAuthContext, Effect.provideService(CurrentSession, session));
