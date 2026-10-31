import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { afterAll } from "vitest";
import { CurrentSession } from "../apiSchema.js";
import { asRoot, DatabaseLive, runQuery, type KyselyDB } from "../db.js";
import { randomSuffix, withCapturedLogs } from "../testSupport.js";
import { SessionService } from "../services/sessionService.js";
import { valkey } from "../valkey.js";
import { getHeadCommit } from "./playgroundRepo.js";
import { getPageData } from "./getPageData.js";

/**
 * One fixed instant for every seeded commit, so a test that needs two commits
 * to share a timestamp gets exactly that.
 */
const fixedInstant = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

const insertPlayground = (db: KyselyDB, hash: string) =>
  runQuery(db.insertInto("app_public.playgrounds").values({ hash, privacy: "public" }));

/**
 * What a seeded commit holds in its jsonb column: the shape the app writes, or
 * the broken shape the tests need in order to prove the read refuses it.
 */
type SeededCommitData =
  | {
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
      readonly activeFile?: string;
    }
  | { readonly files: string };

/**
 * One commit of `hash`. `createdAt` is given explicitly so that two commits can
 * share a timestamp.
 */
const insertCommit = (
  db: KyselyDB,
  hash: string,
  message: string,
  data: SeededCommitData,
  createdAt: Date,
) =>
  runQuery(
    db
      .insertInto("app_public.playground_commits")
      .values({
        playground_hash: hash,
        message,
        data: JSON.stringify(data),
        created_at: createdAt,
      })
      .returning("id"),
  ).pipe(Effect.head);

const setHead = (db: KyselyDB, hash: string, commitId: string) =>
  runQuery(
    db
      .updateTable("app_public.playgrounds")
      .set({ head_commit_id: commitId })
      .where("hash", "=", hash),
  );

/** Clears the head first: the commits cannot go while a playground names one. */
const dropPlayground = (db: KyselyDB, hash: string) =>
  runQuery(
    db.updateTable("app_public.playgrounds").set({ head_commit_id: null }).where("hash", "=", hash),
  ).pipe(
    Effect.andThen(
      runQuery(db.deleteFrom("app_public.playground_commits").where("playground_hash", "=", hash)),
    ),
    Effect.andThen(runQuery(db.deleteFrom("app_public.playgrounds").where("hash", "=", hash))),
  );

/** Nobody is signed in: these playgrounds are public, so RLS lets them through. */
const anonymous = { user: null, session: null };

/**
 * Seeds a public playground, runs `use` with its hash, and removes it again.
 */
const withPlayground = <A, E, R>(use: (hash: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const suffix = yield* randomSuffix;
    const hash = `pgtest${suffix}`;
    yield* asRoot((db) => insertPlayground(db, hash));
    return yield* Effect.ensuring(
      use(hash),
      asRoot((db) => dropPlayground(db, hash)).pipe(Effect.asVoid, Effect.orDie),
    );
  });

// server/valkey.ts holds one client for the process, which the session service
// under test shares, so the suite has to close it or vitest waits on an open
// handle.
afterAll(() => valkey.quit());

layer(
  SessionService.layer.pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer))),
  { timeout: "30 seconds" },
)("the commit a server-rendered page starts from", (it) => {
  it.effect("reads the commit the playground names as head, not the newest by clock", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        // One timestamp for both commits: ordering by the clock cannot tell
        // them apart, which is why the head is a column and not a maximum.
        const first = yield* asRoot((db) =>
          insertCommit(
            db,
            hash,
            "first",
            { files: [{ path: "a.sql", content: "select 1" }] },
            fixedInstant,
          ),
        );
        const second = yield* asRoot((db) =>
          insertCommit(
            db,
            hash,
            "second",
            { files: [{ path: "b.sql", content: "select 2" }] },
            fixedInstant,
          ),
        );
        yield* asRoot((db) => setHead(db, hash, first.id));

        const commit = yield* getHeadCommit(hash).pipe(
          Effect.provideService(CurrentSession, anonymous),
        );

        expect(commit?.id).toBe(first.id);
        expect(commit?.id).not.toBe(second.id);
        expect(commit?.message).toBe("first");
        expect(commit?.files).toEqual([{ path: "a.sql", content: "select 1" }]);
      }),
    ),
  );

  it.effect("answers null for a playground with no head commit", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        yield* asRoot((db) => insertCommit(db, hash, "orphan", { files: [] }, fixedInstant));

        const commit = yield* getHeadCommit(hash).pipe(
          Effect.provideService(CurrentSession, anonymous),
        );

        // The playground has a commit, but names none as its head, so there is
        // nothing for the page to start from.
        expect(commit).toBeNull();
      }),
    ),
  );

  it.effect("answers null for a hash no playground has", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const commit = yield* getHeadCommit(`absent${suffix}`).pipe(
        Effect.provideService(CurrentSession, anonymous),
      );
      expect(commit).toBeNull();
    }),
  );

  it.effect("fails rather than reporting an empty workspace for data that is not a file list", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        const head = yield* asRoot((db) =>
          insertCommit(db, hash, "malformed", { files: "not-an-array" }, fixedInstant),
        );
        yield* asRoot((db) => setHead(db, hash, head.id));

        const error = yield* Effect.flip(
          getHeadCommit(hash).pipe(Effect.provideService(CurrentSession, anonymous)),
        );
        // A commit whose jsonb does not describe a file list is a broken
        // commit, not an empty one, so the read fails and the caller decides.
        expect(error._tag).toBe("SchemaError");
      }),
    ),
  );

  it.effect("serves the page without a commit, and says why, when the commit is broken", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        const head = yield* asRoot((db) =>
          insertCommit(db, hash, "malformed", { files: "not-an-array" }, fixedInstant),
        );
        yield* asRoot((db) => setHead(db, hash, head.id));

        const { result, lines } = yield* withCapturedLogs(
          getPageData(`/playgrounds/${hash}`, null),
        );

        // The workbench boots either way and asks for the playground itself, so
        // a broken commit costs a round trip rather than the whole page - but it
        // must not look like an empty playground, so it is logged.
        expect(result.commit).toBeNull();
        expect(result.user).toBeNull();
        expect(result.route).toEqual({ type: "playground", playgroundHash: hash });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("Rendering the page without its commit");
      }),
    ),
  );

  it.effect("serves a readable head commit as the page's initial data", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        const head = yield* asRoot((db) =>
          insertCommit(
            db,
            hash,
            "initial",
            { files: [{ path: "a.sql", content: "select 1" }], activeFile: "a.sql" },
            fixedInstant,
          ),
        );
        yield* asRoot((db) => setHead(db, hash, head.id));

        const { result, lines } = yield* withCapturedLogs(
          getPageData(`/playgrounds/${hash}`, null),
        );

        expect(result.commit?.id).toBe(head.id);
        expect(result.commit?.activeFile).toBe("a.sql");
        expect(lines).toEqual([]);
      }),
    ),
  );
});
