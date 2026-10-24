import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Random } from "effect";
import { sql } from "kysely";
import { asRoot, DatabaseLive, runQuery, unwrapPgError, type KyselyDB } from "../db.js";
import { CurrentSession, type SessionData } from "../apiSchema.js";
import { PlaygroundService } from "./playgroundService.js";
import { SessionService } from "./sessionService.js";

const TestLayer = Layer.mergeAll(SessionService.layer, PlaygroundService.layer).pipe(
  Layer.provideMerge(DatabaseLive),
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

layer(TestLayer, { timeout: "30 seconds" })("Playground visibility", (it) => {
  it.effect("applies visibility rules to browse, search, and profiles", () =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const playgroundService = yield* PlaygroundService;
      const suffix = yield* randomSuffix;
      const ownerUsername = `visibility_owner_${suffix}`;
      const otherUsername = `visibility_other_${suffix}`;
      // Sponsors, because these cases need a playground at every privacy level
      // and private is a sponsor entitlement.
      const users = yield* asRoot((rootDb) =>
        Effect.all([
          createUser(rootDb, ownerUsername, "sponsor"),
          createUser(rootDb, otherUsername, "sponsor"),
        ]),
      );
      const [owner, other] = users;
      const ownerHashes = yield* asRoot((rootDb) =>
        insertPlaygrounds(rootDb, owner.id, "owner", suffix),
      );
      const otherHashes = yield* asRoot((rootDb) =>
        insertPlaygrounds(rootDb, other.id, "other", suffix),
      );
      const hashes = { owner: ownerHashes, other: otherHashes };
      const fixtures = new Set(Object.values(hashes).flatMap((group) => Object.values(group)));

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const ownerToken = yield* sessionService.createSession(owner.id);
          const otherToken = yield* sessionService.createSession(other.id);
          const ownerSession = yield* sessionService.validateSessionToken(ownerToken.token);
          const otherSession = yield* sessionService.validateSessionToken(otherToken.token);
          if (!ownerSession.session || !otherSession.session) {
            return yield* Effect.die(new Error("Failed to create test sessions"));
          }

          const anonymous = yield* listAll(
            playgroundService,
            anonymousSession,
            ownerUsername,
            fixtures,
          );
          const ownerView = yield* listAll(
            playgroundService,
            ownerSession,
            ownerUsername,
            fixtures,
          );
          const otherView = yield* listAll(
            playgroundService,
            otherSession,
            ownerUsername,
            fixtures,
          );

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
        asRoot((rootDb) =>
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
      const playgroundService = yield* PlaygroundService;
      const hash = `anon_public_${yield* randomSuffix}`;

      yield* asRoot((rootDb) =>
        rootDb
          .insertInto("app_public.playgrounds")
          .values({ hash, user_id: null, privacy: "public", name: hash }),
      );

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const rows = yield* playgroundService.list({});
          const row = rows.find((candidate) => candidate.hash === hash);
          expect(row).toBeDefined();
          expect(row?.user).toBeNull();
        }).pipe(Effect.provideService(CurrentSession, anonymousSession)),
        asRoot((rootDb) =>
          rootDb.deleteFrom("app_public.playgrounds").where("hash", "=", hash),
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
      const free = yield* asRoot((rootDb) => createUser(rootDb, `privacy_free_${suffix}`, "user"));
      const sponsor = yield* asRoot((rootDb) =>
        createUser(rootDb, `privacy_sponsor_${suffix}`, "sponsor"),
      );

      const insertPrivate = (userId: string | null, hash: string) =>
        asRoot((rootDb) =>
          rootDb
            .insertInto("app_public.playgrounds")
            .values({ hash, user_id: userId, privacy: "private", name: hash }),
        );

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* expectDenied(insertPrivate(free.id, `free_private_${suffix}`));
          yield* expectDenied(insertPrivate(null, `anon_private_${suffix}`));

          // A sponsor may hold one, and may not keep it after a downgrade.
          const sponsorHash = `sponsor_private_${suffix}`;
          yield* insertPrivate(sponsor.id, sponsorHash);
          yield* asRoot((rootDb) =>
            rootDb
              .updateTable("app_public.users")
              .set({ role: "user" })
              .where("id", "=", sponsor.id),
          );
          yield* expectDenied(
            asRoot((rootDb) =>
              rootDb
                .updateTable("app_public.playgrounds")
                .set({ privacy: "private" })
                .where("hash", "=", sponsorHash),
            ),
          );
        }),
        asRoot((rootDb) =>
          Effect.all([deleteUser(rootDb, free.id), deleteUser(rootDb, sponsor.id)]),
        ).pipe(Effect.asVoid, Effect.orDie),
      );
    }),
  );
});

/**
 * Assert an effect fails with the DNIED error code the entitlement trigger raises.
 * Flipping makes success the failure, so a write that goes through fails the test.
 */
const expectDenied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.flatMap(unwrapPgError),
    Effect.map((dbErr) => expect(dbErr?.code).toBe("DNIED")),
  );

const createUser = (db: KyselyDB, username: string, role: "user" | "sponsor") =>
  runQuery(
    db
      .selectFrom(
        sql<{ id: string; username: string }>`app_private.really_create_user(
        username => ${username}::citext,
        email => ${`${username}@example.com`}::text,
        email_is_verified => true,
        password => ${"TestPassword123!"}::text
      )`.as("user"),
      )
      .selectAll(),
  ).pipe(
    Effect.head,
    Effect.tap((user) =>
      runQuery(db.updateTable("app_public.users").set({ role }).where("id", "=", user.id)),
    ),
  );

const insertPlaygrounds = Effect.fnUntraced(function* (
  db: KyselyDB,
  userId: string,
  prefix: string,
  suffix: string,
) {
  const rows = {
    private: `${prefix}_private_${suffix}`,
    secret: `${prefix}_secret_${suffix}`,
    public: `${prefix}_public_${suffix}`,
  } as const;
  yield* runQuery(
    db.insertInto("app_public.playgrounds").values(
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

const deleteUser = (db: KyselyDB, userId: string) =>
  runQuery(db.deleteFrom("app_public.users").where("id", "=", userId));

const listAll = (
  service: (typeof PlaygroundService)["Service"],
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
  }).pipe(Effect.provideService(CurrentSession, session));
