import { Effect } from "effect";
import * as S from "effect/Schema";
import { sql } from "kysely";

import { PgRootDB, queriesOn, type DB, type Queries } from "../db.js";
import { randomSuffix } from "../testSupport.js";

/**
 * Seeds a public playground, runs `use` with its hash, and removes it again.
 * Public, so a visitor with no session can read it through RLS.
 */
export const withPlayground = <A, E, R>(use: (hash: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const hash = `pgtest${yield* randomSuffix}`;
    const db = queriesOn<DB>(yield* PgRootDB);
    yield* db.exec((k) =>
      k.insertInto("app_public.playgrounds").values({ hash, privacy: "public" }),
    );
    return yield* Effect.ensuring(use(hash), dropPlayground(db, hash).pipe(Effect.orDie));
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

const SeededCommitDataSchema = S.fromJsonString(
  S.Union([
    S.Struct({
      files: S.Array(S.Struct({ path: S.String, content: S.String })),
      activeFile: S.optional(S.String),
    }),
    S.Struct({ files: S.String }),
  ]),
);

/**
 * One commit of `hash`, written as the owner. `createdAt` is explicit, so two
 * commits can share a timestamp or run against their order in the chain.
 */
export const insertCommit = (
  db: Queries<DB>,
  hash: string,
  commit: {
    readonly message: string;
    readonly data: SeededCommitData;
    readonly createdAt: Date;
    readonly parentId?: string;
    readonly userId?: string;
  },
) =>
  db.one(S.Struct({ id: S.String }), (k) =>
    k
      .insertInto("app_public.playground_commits")
      .values({
        playground_hash: hash,
        parent_id: commit.parentId ?? null,
        user_id: commit.userId ?? null,
        message: commit.message,
        // JSON text goes through text: a string sent to a json parameter is encoded twice.
        data: sql`${S.encodeSync(SeededCommitDataSchema)(commit.data)}::text::jsonb` as never,
        created_at: commit.createdAt,
      })
      .returning("id"),
  );

export const setHead = (db: Queries<DB>, hash: string, commitId: string) =>
  db.exec((k) =>
    k
      .updateTable("app_public.playgrounds")
      .set({ head_commit_id: commitId })
      .where("hash", "=", hash),
  );

/** Clears the head first: the commits cannot go while a playground names one. */
export const dropPlayground = (db: Queries<DB>, hash: string) =>
  db
    .exec((k) =>
      k
        .updateTable("app_public.playgrounds")
        .set({ head_commit_id: null })
        .where("hash", "=", hash),
    )
    .pipe(
      Effect.andThen(
        db.exec((k) =>
          k.deleteFrom("app_public.playground_commits").where("playground_hash", "=", hash),
        ),
      ),
      Effect.andThen(
        db.exec((k) => k.deleteFrom("app_public.playgrounds").where("hash", "=", hash)),
      ),
    );
