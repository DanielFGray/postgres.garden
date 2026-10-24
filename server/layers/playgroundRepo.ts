/**
 * Server-side PlaygroundRepo implementation.
 *
 * Queries commits via Kysely + RLS (asVisitor).
 * Wraps existing logic from initialData.ts getRouteCommit().
 */

import { Effect, Layer, Schema } from "effect";
import { PlaygroundRepo } from "../../src/shared/services.js";
import { Commit } from "../../src/shared/schemas.js";
import { asVisitor, type VisitorContext } from "../db.js";

const CommitDataSchema = Schema.Struct({
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  ),
  activeFile: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Commit data is stored as jsonb, so a malformed row is possible. It reads as an
 * empty commit instead of failing the page.
 */
const mapCommit = (row: {
  readonly id: string;
  readonly message: string;
  readonly data: unknown;
  readonly created_at: Date;
  readonly playground_hash: string;
  readonly parent_id: string | null;
}) =>
  Schema.decodeUnknownEffect(CommitDataSchema)(row.data).pipe(
    Effect.map((d) => ({ files: d.files ?? [], activeFile: d.activeFile ?? null })),
    Effect.orElseSucceed(() => ({ files: [], activeFile: null })),
    Effect.map(
      ({ files, activeFile }) =>
        new Commit({
          id: row.id,
          message: row.message,
          created_at: row.created_at.toISOString(),
          playground_hash: row.playground_hash,
          parent_id: row.parent_id,
          files: Array.from(files),
          activeFile,
          timestamp: row.created_at.getTime(),
        }),
    ),
  );

export const PlaygroundRepoServer = Layer.effect(
  PlaygroundRepo,
  Effect.gen(function* () {
    // `PlaygroundRepo` is shared with the client, so its methods must not carry
    // server-only requirements. Capture them once when the layer is built.
    const ctx = yield* Effect.context<VisitorContext>();
    const run = <A, E>(effect: Effect.Effect<A, E, VisitorContext>) => Effect.provide(effect, ctx);

    return {
      getLatestCommit: (playgroundId: string) =>
        run(
          asVisitor((authDb) =>
            authDb
              .selectFrom("app_public.playground_commits")
              .select(["id", "message", "data", "created_at", "playground_hash", "parent_id"])
              .where("playground_hash", "=", playgroundId)
              .orderBy("created_at", "desc")
              .limit(1),
          ).pipe(Effect.flatMap(([row]) => (row ? mapCommit(row) : Effect.succeed(null)))),
        ).pipe(Effect.orElseSucceed(() => null)),

      getCommit: (playgroundId: string, commitId: string) =>
        run(
          asVisitor((authDb) =>
            authDb
              .selectFrom("app_public.playground_commits")
              .select(["id", "message", "data", "created_at", "playground_hash", "parent_id"])
              .where("playground_hash", "=", playgroundId)
              .where("id", "=", commitId),
          ).pipe(Effect.flatMap(([row]) => (row ? mapCommit(row) : Effect.succeed(null)))),
        ).pipe(Effect.orElseSucceed(() => null)),
    };
  }),
);
