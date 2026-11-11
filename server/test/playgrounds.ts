import { Effect } from "effect";

import { PgRootDB, type DbHandle } from "../db.js";
import { randomSuffix } from "../testSupport.js";

/**
 * Seeds a public playground, runs `use` with its hash, and removes it again.
 * Public, so a visitor with no session can read it through RLS.
 */
export const withPlayground = <A, E, R>(use: (hash: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const hash = `pgtest${yield* randomSuffix}`;
    yield* PgRootDB.use((db) =>
      db.all(
        db.connection.insertInto("app_public.playgrounds").values({ hash, privacy: "public" }),
      ),
    );
    return yield* Effect.ensuring(
      use(hash),
      PgRootDB.use((db) => dropPlayground(db, hash)).pipe(Effect.asVoid, Effect.orDie),
    );
  });

/**
 * What a seeded commit holds in its jsonb column: the shape the app writes, or
 * the broken shape a test needs in order to prove a read refuses it.
 */
export type SeededCommitData =
  | {
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
      readonly activeFile?: string;
    }
  | { readonly files: string };

/**
 * One commit of `hash`, written as the owner. `createdAt` is explicit, so two
 * commits can share a timestamp or run against their order in the chain.
 */
export const insertCommit = (
  db: DbHandle,
  hash: string,
  commit: {
    readonly message: string;
    readonly data: SeededCommitData;
    readonly createdAt: Date;
    readonly parentId?: string;
    readonly userId?: string;
  },
) =>
  db
    .all(
      db.connection
        .insertInto("app_public.playground_commits")
        .values({
          playground_hash: hash,
          parent_id: commit.parentId ?? null,
          user_id: commit.userId ?? null,
          message: commit.message,
          data: JSON.stringify(commit.data),
          created_at: commit.createdAt,
        })
        .returning("id"),
    )
    .pipe(Effect.head);

export const setHead = (db: DbHandle, hash: string, commitId: string) =>
  db.all(
    db.connection
      .updateTable("app_public.playgrounds")
      .set({ head_commit_id: commitId })
      .where("hash", "=", hash),
  );

/** Clears the head first: the commits cannot go while a playground names one. */
export const dropPlayground = (db: DbHandle, hash: string) =>
  db
    .all(
      db.connection
        .updateTable("app_public.playgrounds")
        .set({ head_commit_id: null })
        .where("hash", "=", hash),
    )
    .pipe(
      Effect.andThen(
        db.all(
          db.connection
            .deleteFrom("app_public.playground_commits")
            .where("playground_hash", "=", hash),
        ),
      ),
      Effect.andThen(
        db.all(db.connection.deleteFrom("app_public.playgrounds").where("hash", "=", hash)),
      ),
    );
