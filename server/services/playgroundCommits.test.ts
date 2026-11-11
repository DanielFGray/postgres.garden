import { NodeCrypto } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { CurrentSession } from "../../shared/session.js";
import { DatabaseLive, PgRootDB } from "../db.js";
import { withAuthContext } from "../requestDatabase.js";
import { Secrets } from "../secrets.js";
import { insertCommit, setHead, withPlayground } from "../test/playgrounds.js";
import { PlaygroundService } from "./playgroundService.js";

const at = (iso: string) => DateTime.toDate(DateTime.makeUnsafe(iso));

const data = { files: [] };

layer(
  PlaygroundService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, NodeCrypto.layer, Secrets.layer)),
  ),
  { excludeTestServices: true, timeout: "30 seconds" },
)("a playground's commit list", (it) => {
  it.effect("follows the chain back from the head whatever the clock says, then the rest", () =>
    withPlayground((hash) =>
      Effect.gen(function* () {
        // Each commit on the chain is older by the clock than its parent. A
        // fork and the save on it share one transaction's now(), and a save
        // whose transaction began first can be stamped before its parent, so
        // the clock is no witness to the order.
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
            // A second child of root, as two saves that read the same head
            // leave behind: the head did not come from it.
            const off = yield* insertCommit(db, hash, {
              message: "off the chain",
              data,
              createdAt: at("2026-01-01T00:00:04Z"),
              parentId: root.id,
            });
            yield* setHead(db, hash, head.id);
            return [head.id, middle.id, root.id, off.id];
          }),
        );

        const commits = yield* PlaygroundService.use((playgrounds) =>
          playgrounds.listCommits(hash),
        ).pipe(
          withAuthContext,
          Effect.provideService(CurrentSession, { user: null, session: null }),
        );

        expect(commits.map((commit) => commit.id)).toEqual(seeded);
      }),
    ),
  );
});
