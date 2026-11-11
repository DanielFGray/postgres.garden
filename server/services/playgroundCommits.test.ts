import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Array, DateTime, Duration, Effect, Fiber, Layer, Option, Schedule } from "effect";
import { sql } from "kysely";
import { CurrentSession } from "../../shared/session.js";
import { DatabaseLive, type DatabaseError, PgRootDB } from "../db.js";
import { withAuthContext } from "../requestDatabase.js";
import { Secrets } from "../secrets.js";
import { createUser, deleteUser, randomSuffix } from "../testSupport.js";
import { dropPlayground, insertCommit, setHead, withPlayground } from "../test/playgrounds.js";
import { PlaygroundService } from "./playgroundService.js";

const at = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));

const data = { files: [] };

const anonymous = Effect.provideService(CurrentSession, { user: null, session: null });

const files = (content: string) => [{ path: "a.sql", content }];

/** Starts a playground with no account, runs `use` with it, and removes it again. */
const withAnonymousPlayground = <A, E, R>(
  use: (created: {
    readonly hash: string;
    readonly first: string;
    readonly editKey: string | null;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const created = yield* PlaygroundService.use((playgrounds) =>
      playgrounds.create({ message: "first", files: files("select 1") }),
    ).pipe(withAuthContext, anonymous);
    return yield* Effect.ensuring(
      use({
        hash: created.playground_hash,
        first: created.commit_id,
        editKey: created.edit_key,
      }),
      PgRootDB.use((db) => dropPlayground(db, created.playground_hash)).pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
    );
  });

/** A save to `hash` as the edit key's holder, naming `basis` as what it was edited from. */
const save = (
  created: { readonly hash: string; readonly editKey: string | null },
  basis: string | null,
  content: string,
) =>
  PlaygroundService.use((playgrounds) =>
    playgrounds.createCommit(
      null,
      created.hash,
      { message: content, files: files(content), basis },
      created.editKey,
    ),
  ).pipe(withAuthContext, anonymous);

/** The SQLSTATE the database refused with. */
const refusalCode = (error: DatabaseError) => Option.map(error.report, (report) => report.code);

/** A save that fails other than by the database refusing it is a broken test. */
const refusedBy = (error: { readonly _tag: "NoSuchElementError" } | DatabaseError) =>
  error._tag === "DatabaseError" ? Effect.succeed(error) : Effect.die(error);

/**
 * How many lock requests wait. pg_stat_activity would name the waiting
 * statements, but it hides the sessions of another role, and the saves run as
 * the visitor; pg_locks shows every role's locks. A lock that another test
 * file waits on can count too and release the saves early, which weakens the
 * race but cannot fail a correct function.
 */
const locksWaiting = PgRootDB.use((db) =>
  db.one(
    db.raw(
      sql<{ waiting: number }>`select count(*)::int as waiting from pg_locks where not granted`,
    ),
  ),
).pipe(Effect.map(({ waiting }) => waiting));

const listCommitIds = (hash: string) =>
  PlaygroundService.use((playgrounds) => playgrounds.listCommits(hash)).pipe(
    withAuthContext,
    anonymous,
    Effect.map((commits) => commits.map((commit) => commit.id)),
  );

layer(
  PlaygroundService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, Secrets.layer)),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("a playground's commit chain", (it) => {
  it.effect("lists the chain back from the head, whatever the clock says", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        // Each commit is older by the clock than its parent. A fork and the
        // save on it share one transaction's now(), and a save whose
        // transaction began first can be stamped before its parent, so the
        // clock is no witness to the order.
        const seeded = yield* PgRootDB.use((db) =>
          Effect.gen(function* () {
            const root = yield* insertCommit(db, hash, {
              message: "root",
              data,
              createdAt: at("2026-01-01T00:00:03Z"),
            });
            const middle = yield* insertCommit(db, hash, {
              message: "middle",
              data,
              createdAt: at("2026-01-01T00:00:02Z"),
              parentId: root.id,
            });
            const head = yield* insertCommit(db, hash, {
              message: "head",
              data,
              createdAt: at("2026-01-01T00:00:01Z"),
              parentId: middle.id,
            });
            yield* setHead(db, hash, head.id);
            return [head.id, middle.id, root.id];
          }),
        );

        expect(yield* listCommitIds(hash)).toEqual(seeded);
      }),
    ),
  );

  it.effect("lets one of several saves from the same head through and refuses the rest", () =>
    withAnonymousPlayground((created) =>
      Effect.gen(function* () {
        // Each save is its own transaction on its own connection. Left alone,
        // the first can commit before the others connect, and they never
        // race. The table lock holds every save at its insert until all five
        // wait, so all five have read the head by then. Without the row lock
        // in create_playground_commit they all read the same one, and four
        // inserts fail on the one-child constraint instead of naming the
        // conflict.
        const racing = yield* PgRootDB.use((db) =>
          db.transaction((trx) =>
            Effect.gen(function* () {
              yield* trx.all(trx.raw(sql`lock table app_public.playground_commits in share mode`));
              const saves = yield* Effect.forkChild(
                Effect.all(
                  Array.makeBy(5, (i) =>
                    Effect.result(save(created, created.first, `select ${i}`)),
                  ),
                  { concurrency: "unbounded" },
                ),
              );
              yield* locksWaiting.pipe(
                Effect.repeat({
                  until: (waiting) => waiting >= 5,
                  schedule: Schedule.spaced(Duration.millis(10)),
                }),
              );
              return saves;
            }),
          ),
        );
        const results = yield* Fiber.join(racing);

        const [saved, failed] = Array.separate(results);
        const refused = yield* Effect.forEach(failed, refusedBy);
        expect(saved).toHaveLength(1);
        expect(refused.map(refusalCode)).toEqual(Array.replicate(Option.some("STALE"), 4));
        expect(yield* listCommitIds(created.hash)).toEqual([saved[0]?.commit_id, created.first]);
      }),
    ),
  );

  it.effect("deletes only the head, and the head steps back to its parent", () =>
    withAnonymousPlayground((created) =>
      Effect.gen(function* () {
        const second = yield* save(created, created.first, "select 2");

        const middle = yield* PgRootDB.use((db) =>
          db.all(
            db.connection
              .deleteFrom("app_public.playground_commits")
              .where("id", "=", created.first),
          ),
        ).pipe(Effect.flip);
        // 23503: a foreign key still refers to the row, here the child's parent.
        expect(Option.map(middle.report, (report) => report.code)).toEqual(Option.some("23503"));

        yield* PgRootDB.use((db) =>
          db.all(
            db.connection
              .deleteFrom("app_public.playground_commits")
              .where("id", "=", second.commit_id),
          ),
        );
        expect(yield* listCommitIds(created.hash)).toEqual([created.first]);
        // The head is back on the first commit, so a save from it is taken.
        yield* save(created, created.first, "select 3");
      }),
    ),
  );

  it.effect("takes a save with no basis as the new root of a playground emptied by a delete", () =>
    withAnonymousPlayground((created) =>
      Effect.gen(function* () {
        yield* PgRootDB.use((db) =>
          db.all(
            db.connection
              .deleteFrom("app_public.playground_commits")
              .where("id", "=", created.first),
          ),
        );
        expect(yield* listCommitIds(created.hash)).toEqual([]);

        const root = yield* save(created, null, "select 2");

        expect(root.parent_id).toBeNull();
        expect(yield* listCommitIds(created.hash)).toEqual([root.commit_id]);
      }),
    ),
  );

  it.effect("still deletes an account with its playgrounds and their chains", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const hash = `pgchain${suffix}`;
      yield* PgRootDB.use((db) =>
        Effect.gen(function* () {
          const user = yield* createUser(db, `chain_${suffix}`);
          yield* db.all(
            db.connection
              .insertInto("app_public.playgrounds")
              .values({ hash, privacy: "public", user_id: user.id }),
          );
          // The account wrote each commit, so deleting it reaches them twice:
          // through the playground and through their author.
          const root = yield* insertCommit(db, hash, {
            message: "root",
            data,
            createdAt: at("2026-01-01T00:00:01Z"),
            userId: user.id,
          });
          const head = yield* insertCommit(db, hash, {
            message: "head",
            data,
            createdAt: at("2026-01-01T00:00:02Z"),
            parentId: root.id,
            userId: user.id,
          });
          yield* setHead(db, hash, head.id);

          yield* deleteUser(db, user.id);

          const left = yield* db.all(
            db.connection
              .selectFrom("app_public.playground_commits")
              .select("id")
              .where("playground_hash", "=", hash),
          );
          expect(left).toEqual([]);
        }),
      );
    }),
  );
});
