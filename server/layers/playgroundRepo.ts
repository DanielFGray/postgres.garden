/**
 * Reads the commit a server-rendered page starts from.
 *
 * Every query runs as the visitor, so row-level security decides what the
 * caller may see. A playground that does not exist and one the caller may not
 * read are the same answer, `null`, because the database deliberately does not
 * tell them apart. Everything else fails: a database that cannot be reached,
 * or a commit whose jsonb does not describe a file list, is not an empty
 * workspace, and the caller decides what to do about it.
 */

import { Effect, Schema } from "effect";
import { Commit } from "../../src/shared/schemas.js";
import { asVisitor } from "../db.js";

const CommitData = Schema.Struct({
  files: Schema.optional(
    Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  ),
  activeFile: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCommitData = Schema.decodeUnknownEffect(CommitData);

type CommitRow = {
  readonly id: string;
  readonly message: string;
  readonly data: unknown;
  readonly created_at: Date;
  readonly playground_hash: string;
  readonly parent_id: string | null;
};

const toCommit = (row: CommitRow) =>
  decodeCommitData(row.data).pipe(
    Effect.map(
      (data) =>
        new Commit({
          id: row.id,
          message: row.message,
          created_at: row.created_at.toISOString(),
          playground_hash: row.playground_hash,
          parent_id: row.parent_id,
          files: Array.from(data.files ?? []),
          activeFile: data.activeFile ?? null,
          timestamp: row.created_at.getTime(),
        }),
    ),
  );

const firstCommit = (rows: ReadonlyArray<CommitRow>) => {
  const [row] = rows;
  return row ? toCommit(row) : Effect.succeed(null);
};

/** The commit a playground names as its head, or `null` if it has none. */
export const getHeadCommit = (playgroundHash: string) =>
  asVisitor((authDb) =>
    authDb
      .selectFrom("app_public.playground_commits as c")
      .innerJoin("app_public.playgrounds as p", "p.head_commit_id", "c.id")
      .select(["c.id", "c.message", "c.data", "c.created_at", "c.playground_hash", "c.parent_id"])
      .where("p.hash", "=", playgroundHash),
  ).pipe(Effect.flatMap(firstCommit));

/** One named commit of a playground, or `null` if it is not there. */
export const getCommit = (playgroundHash: string, commitId: string) =>
  asVisitor((authDb) =>
    authDb
      .selectFrom("app_public.playground_commits")
      .select(["id", "message", "data", "created_at", "playground_hash", "parent_id"])
      .where("playground_hash", "=", playgroundHash)
      .where("id", "=", commitId),
  ).pipe(Effect.flatMap(firstCommit));
