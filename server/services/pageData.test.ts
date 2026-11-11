import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { DatabaseLive, PgRootDB } from "../db.js";
import { randomSuffix, withCapturedLogs } from "../testSupport.js";
import { SessionService } from "./sessionService.js";
import { TestValkeyLive } from "../test/valkey.js";
import { insertCommit, setHead, withPlayground } from "../test/playgrounds.js";
import { PageData } from "./pageData.js";
import { withAuthContext } from "../requestDatabase.js";
import { CurrentSession } from "../../shared/session.js";

/**
 * One fixed instant for every seeded commit, so a test that needs two commits
 * to share a timestamp gets exactly that.
 */
const fixedInstant = DateTime.toDate(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"));

/** Nobody is signed in: these playgrounds are public, so RLS lets them through. */
const headCommit = (hash: string) =>
  PageData.use((pages) => pages.headCommit(hash)).pipe(
    withAuthContext,
    Effect.provideService(CurrentSession, { user: null, session: null }),
  );

layer(
  PageData.layer.pipe(
    Layer.provideMerge(SessionService.layer),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, TestValkeyLive)),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("the commit a server-rendered page starts from", (it) => {
  it.effect("reads the commit the playground names as head, not the newest by clock", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        // One timestamp for both commits: ordering by the clock cannot tell
        // them apart, which is why the head is a column and not a maximum.
        const first = yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "first",
            data: { files: [{ path: "a.sql", content: "select 1" }] },
            createdAt: fixedInstant,
          }),
        );
        const second = yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "second",
            data: { files: [{ path: "b.sql", content: "select 2" }] },
            createdAt: fixedInstant,
            parentId: first.id,
          }),
        );
        yield* PgRootDB.use((db) => setHead(db, hash, second.id));

        const commit = yield* headCommit(hash);

        expect(commit?.id).toBe(second.id);
        expect(commit?.id).not.toBe(first.id);
        expect(commit?.message).toBe("second");
        expect(commit?.files).toEqual([{ path: "b.sql", content: "select 2" }]);
      }),
    ),
  );

  it.effect("answers null for a playground with no head commit", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "orphan",
            data: { files: [] },
            createdAt: fixedInstant,
          }),
        );

        const commit = yield* headCommit(hash);

        // The playground has a commit, but names none as its head, so there is
        // nothing for the page to start from.
        expect(commit).toBeNull();
      }),
    ),
  );

  it.effect("answers null for a hash no playground has", () =>
    Effect.gen(function* () {
      const suffix = yield* randomSuffix;
      const commit = yield* headCommit(`absent${suffix}`);
      expect(commit).toBeNull();
    }),
  );

  it.effect("fails rather than reporting an empty workspace for data that is not a file list", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        const head = yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "malformed",
            data: { files: "not-an-array" },
            createdAt: fixedInstant,
          }),
        );
        yield* PgRootDB.use((db) => setHead(db, hash, head.id));

        const error = yield* Effect.flip(headCommit(hash));
        // A commit whose jsonb does not describe a file list is a broken
        // commit, not an empty one, so the read fails and the caller decides.
        expect(error._tag).toBe("SchemaError");
      }),
    ),
  );

  it.effect("serves the page without a commit, and says why, when the commit is broken", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        const head = yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "malformed",
            data: { files: "not-an-array" },
            createdAt: fixedInstant,
          }),
        );
        yield* PgRootDB.use((db) => setHead(db, hash, head.id));

        const { result, lines } = yield* withCapturedLogs(
          PageData.use((pages) => pages.initialState(`/playgrounds/${hash}`, Option.none())),
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
        const head = yield* PgRootDB.use((db) =>
          insertCommit(db, hash, {
            message: "initial",
            data: { files: [{ path: "a.sql", content: "select 1" }], activeFile: "a.sql" },
            createdAt: fixedInstant,
          }),
        );
        yield* PgRootDB.use((db) => setHead(db, hash, head.id));

        const { result, lines } = yield* withCapturedLogs(
          PageData.use((pages) => pages.initialState(`/playgrounds/${hash}`, Option.none())),
        );

        expect(result.commit?.id).toBe(head.id);
        expect(result.commit?.activeFile).toBe("a.sql");
        expect(lines).toEqual([]);
      }),
    ),
  );
});
