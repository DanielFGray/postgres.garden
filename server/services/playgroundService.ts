import { Effect, pipe } from "effect";
import { sql } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";
import { PgAuthDB, withAuthContext } from "../db.js";
import { parseSearchDSL } from "lib/searchDSL.js";

export interface ListPlaygroundsQuery {
  readonly offset?: number | null;
  readonly limit?: number | null;
  readonly sort?: "created_at" | "updated_at" | "stars" | null;
}

export interface CreatePlaygroundInput {
  readonly name?: string | null;
  readonly message: string;
  readonly description?: string | null;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly activeFile?: string | null;
}

export interface UpdatePlaygroundInput {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly privacy?: "private" | "secret" | "public" | null;
}

export interface CommitPayload {
  readonly message: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly activeFile?: string | null;
}

export class PlaygroundService extends Effect.Service<PlaygroundService>()("PlaygroundService", {
  effect: Effect.gen(function*() {
    const authDb = yield* PgAuthDB;

    return {
      listForUser: (sessionId: string | undefined, username: string, query: ListPlaygroundsQuery) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.playgrounds as p")
            .innerJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<string>().as("stars")])
                  .groupBy("playground_hash")
                  .as("star_counts"),
              (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
            )
            .orderBy(sql.ref(query.sort ?? "created_at"), query.sort === "stars" ? "desc" : "desc")
            .limit(query.limit ?? 50)
            .where("u.username", "=", username)
            .select((eb) => [
              "p.hash",
              "p.fork_hash",
              "p.name",
              "p.description",
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit("0")).as("stars"),
              "p.created_at",
              "p.updated_at",
            ]),
        ),

      list: (sessionId: string | undefined, query: ListPlaygroundsQuery) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.playgrounds as p")
            .innerJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<string>().as("stars")])
                  .groupBy("playground_hash")
                  .as("star_counts"),
              (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
            )
            .orderBy(sql.ref(query.sort ?? "created_at"), query.sort === "stars" ? "desc" : "desc")
            .limit(query.limit ?? 50)
            .select((eb) => [
              "p.hash",
              "p.fork_hash",
              "p.name",
              "p.description",
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit("0")).as("stars"),
              "p.created_at",
              "p.updated_at",
              jsonBuildObject({ username: eb.ref("u.username") }).as("user"),
            ]),
        ),

      search: (sessionId: string | undefined, q: string, limit?: number, offset?: number) => {
        const parsed = parseSearchDSL(q);
        return withAuthContext(
          authDb,
          sessionId,
          pipe(
            authDb
              .selectFrom("app_public.playgrounds as p")
              .innerJoin("app_public.users as u", "p.user_id", "u.id")
              .leftJoin(
                (eb) =>
                  eb
                    .selectFrom("app_public.playground_stars")
                    .select((eb) => ["playground_hash", eb.fn.countAll<string>().as("stars")])
                    .groupBy("playground_hash")
                    .as("star_counts"),
                (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
              )
              .orderBy(sql.ref(parsed.sort), "desc")
              .limit(limit ?? 50)
              .offset(offset ?? 0),
            (q) =>
              parsed.starred && sessionId
                ? q.innerJoin("app_public.playground_stars as my_stars", (join) =>
                    join
                      .onRef("my_stars.playground_hash", "=", "p.hash")
                      .on("my_stars.user_id", "=", sql`app_public.current_user_id()`),
                  )
                : q,
            (q) => (parsed.username ? q.where("u.username", "=", parsed.username) : q),
            (q) =>
              parsed.text
                ? q.where((eb) =>
                    eb.or([
                      eb("p.name", "ilike", `%${parsed.text}%`),
                      eb("p.description", "ilike", `%${parsed.text}%`),
                    ]),
                  )
                : q,
            (q) =>
              q.select((eb) => [
                "p.hash",
                "p.fork_hash",
                "p.name",
                "p.description",
                eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit("0")).as("stars"),
                "p.created_at",
                "p.updated_at",
                jsonBuildObject({ username: eb.ref("u.username") }).as("user"),
              ]),
          ),
        );
      },

      create: (sessionId: string, body: CreatePlaygroundInput) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom(
              sql<{
                commit_id: string;
                playground_hash: string;
                parent_id: string | null;
                message: string;
                created_at: Date;
              }>`app_public.create_playground_commit(
                ${body.name ?? null},
                ${body.message},
                ${JSON.stringify({ files: body.files, activeFile: body.activeFile })}::jsonb,
                ${null},
                ${body.description ?? null}
              )`.as("result"),
            )
            .selectAll()
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                Effect.dieMessage("create_playground_commit returned no rows"),
              ),
            ),
        ),

      getByHash: (sessionId: string | undefined, hash: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.playgrounds as p")
            .leftJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin("app_public.playgrounds as fork_parent", "p.fork_hash", "fork_parent.hash")
            .leftJoin("app_public.users as fork_owner", "fork_parent.user_id", "fork_owner.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<string>().as("stars")])
                  .groupBy("playground_hash")
                  .as("star_counts"),
              (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
            )
            .leftJoin("app_public.playground_stars as my_star", (join) =>
              join
                .onRef("my_star.playground_hash", "=", "p.hash")
                .on("my_star.user_id", "=", sql`app_public.current_user_id()`),
            )
            .selectAll("p")
            .select((eb) => [
              jsonBuildObject({ username: eb.ref("u.username") }).as("user"),
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit("0")).as("stars"),
              eb("my_star.playground_hash", "is not", null).$castTo<boolean>().as("is_starred"),
              eb
                .case()
                .when("p.fork_hash", "is not", null)
                .then(
                  jsonBuildObject({
                    hash: eb.ref("fork_parent.hash"),
                    name: eb.ref("fork_parent.name"),
                    owner: eb.ref("fork_owner.username"),
                  }),
                )
                .else(null)
                .end()
                .as("fork_of"),
            ])
            .where("p.hash", "=", hash)
            .pipe(Effect.head),
        ),

      fork: (sessionId: string, hash: string, name: string | null | undefined) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom((eb) =>
              eb
                .fn<{
                  commit_id: string;
                  playground_id: number;
                  parent_id: string | null;
                  message: string;
                  created_at: Date;
                }>("app_public.fork_playground", [eb.val(hash), eb.val(name ?? null)])
                .as("result"),
            )
            .selectAll()
            .pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementException", () =>
                Effect.dieMessage("Failed to fork playground"),
              ),
            ),
        ),

      update: (sessionId: string, hash: string, input: UpdatePlaygroundInput) =>
        withAuthContext(
          authDb,
          sessionId,
          pipe(
            authDb.updateTable("app_public.playgrounds").where("hash", "=", hash),
            (q) => (input.name !== undefined ? q.set("name", input.name) : q),
            (q) => (input.description !== undefined ? q.set("description", input.description) : q),
            (q) => (input.privacy != null ? q.set("privacy", input.privacy) : q),
            (q) => q.returningAll(),
            Effect.head,
          ),
        ),

      createCommit: (sessionId: string, userId: string, hash: string, body: CommitPayload) =>
        withAuthContext(
          authDb,
          sessionId,
          Effect.gen(function*() {
            const playground = yield* authDb
              .selectFrom("app_public.playgrounds")
              .select(["hash", "user_id"])
              .where("hash", "=", hash)
              .pipe(Effect.head);

            if (playground.user_id === userId) {
              return yield* authDb
                .selectFrom(
                  sql<{
                    commit_id: string;
                    playground_hash: string;
                    parent_id: string | null;
                    message: string;
                    created_at: Date;
                  }>`app_public.create_playground_commit(
                    ${null},
                    ${body.message},
                    ${JSON.stringify({ files: body.files, activeFile: body.activeFile })}::jsonb,
                    ${hash},
                    ${null}
                  )`.as("result"),
                )
                .selectAll()
                .pipe(
                  Effect.head,
                  Effect.catchTag("NoSuchElementException", () =>
                    Effect.dieMessage("create_playground_commit returned no rows"),
                  ),
                  Effect.map((result) => ({ ...result, forked: false as const })),
                );
            }

            return yield* authDb
              .selectFrom((eb) =>
                eb
                  .fn<{
                    commit_id: string;
                    playground_hash: string;
                    parent_id: string | null;
                    message: string;
                    created_at: Date;
                  }>("app_public.fork_playground", [
                    eb.val(hash),
                    eb.val(`fork-of-${hash.substring(0, 8)}`),
                  ])
                  .as("result"),
              )
              .selectAll()
              .pipe(
                Effect.head,
                Effect.catchTag("NoSuchElementException", () =>
                  Effect.dieMessage("fork_playground returned no rows"),
                ),
                Effect.map((result) => ({ ...result, forked: true as const })),
              );
          }),
        ),

      listCommits: (sessionId: string | undefined, hash: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.playground_commits as c")
            .leftJoin("app_public.users as u", "c.user_id", "u.id")
            .select(["c.id", "c.message", "c.created_at", "c.parent_id", "c.user_id", "u.username"])
            .where("c.playground_hash", "=", hash)
            .orderBy("c.created_at", "desc")
            .pipe(
              Effect.map((commits) =>
                commits.map((commit) => ({
                  id: commit.id,
                  message: commit.message,
                  timestamp: commit.created_at.getTime(),
                  parent_id: commit.parent_id,
                  user_id: commit.user_id,
                  username: commit.username ?? undefined,
                })),
              ),
            ),
        ),

      getCommit: (sessionId: string | undefined, hash: string, commitId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .selectFrom("app_public.playground_commits")
            .select(["id", "message", "data", "created_at", "playground_hash", "parent_id"])
            .where("id", "=", commitId)
            .where("playground_hash", "=", hash)
            .pipe(
              Effect.head,
              Effect.map((commit) => {
                const data = commit.data as {
                  files?: Array<{ path: string; content: string }>;
                  activeFile?: string | null;
                };
                return {
                  id: commit.id,
                  message: commit.message,
                  created_at: commit.created_at,
                  playground_hash: commit.playground_hash,
                  parent_id: commit.parent_id,
                  files: data.files || [],
                  activeFile: data.activeFile || null,
                  timestamp: commit.created_at.getTime(),
                };
              }),
            ),
        ),

      getCommitHistory: (
        sessionId: string | undefined,
        hash: string,
        commitId: string,
        limit = 50,
      ) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .withRecursive("commit_history", (cte) =>
              cte
                .selectFrom("app_public.playground_commits")
                .select([
                  "id",
                  "message",
                  "created_at",
                  "parent_id",
                  "playground_hash",
                  sql<number>`0`.as("depth"),
                ])
                .where("id", "=", commitId)
                .where("playground_hash", "=", hash)
                .unionAll((qb) =>
                  qb
                    .selectFrom("app_public.playground_commits as c")
                    .innerJoin("commit_history as ch", "c.id", "ch.parent_id")
                    .select([
                      "c.id",
                      "c.message",
                      "c.created_at",
                      "c.parent_id",
                      "c.playground_hash",
                      sql<number>`ch.depth + 1`.as("depth"),
                    ])
                    .where((eb) => eb("ch.depth", "<", eb.lit(limit - 1))),
                ),
            )
            .selectFrom("commit_history")
            .selectAll()
            .orderBy("depth", "asc")
            .pipe(
              Effect.map((rows) => {
                const history = rows.map((row) => ({
                  id: row.id,
                  message: row.message,
                  timestamp: row.created_at.getTime(),
                  parent_id: row.parent_id,
                  playground_hash: row.playground_hash,
                }));

                const lastCommit = history[history.length - 1];
                const isComplete = !lastCommit || lastCommit.parent_id === null;
                return { history, isComplete };
              }),
            ),
        ),

      getCommitDiff: (sessionId: string | undefined, hash: string, commitId: string) =>
        withAuthContext(
          authDb,
          sessionId,
          Effect.gen(function*() {
            const commit = yield* authDb
              .selectFrom("app_public.playground_commits")
              .select(["id", "parent_id", "data"])
              .where("id", "=", commitId)
              .where("playground_hash", "=", hash)
              .pipe(Effect.head);

            const currentData = (commit.data as {
              files: Array<{ path: string; content: string }>;
            }) || { files: [] };
            const currentFiles = currentData.files;

            if (!commit.parent_id) {
              return {
                isRootCommit: true,
                added: currentFiles,
                modified: [],
                deleted: [],
              };
            }

            const parentCommit = yield* authDb
              .selectFrom("app_public.playground_commits")
              .select(["data"])
              .where("id", "=", commit.parent_id)
              .pipe(Effect.head);

            const parentData = (parentCommit.data as {
              files: Array<{ path: string; content: string }>;
            }) || { files: [] };
            const parentFiles = parentData.files;

            const currentFileMap = new Map(currentFiles.map((f) => [f.path, f.content]));
            const parentFileMap = new Map(parentFiles.map((f) => [f.path, f.content]));

            const added = currentFiles.filter((f) => !parentFileMap.has(f.path));
            const modified = currentFiles.filter((f) => {
              const parentContent = parentFileMap.get(f.path);
              return parentContent !== undefined && parentContent !== f.content;
            });
            const deleted = parentFiles.filter((f) => !currentFileMap.has(f.path));

            return { isRootCommit: false, added, modified, deleted };
          }),
        ),

      toggleStar: (sessionId: string, hash: string) =>
        withAuthContext(
          authDb,
          sessionId,
          Effect.gen(function*() {
            const deleted = yield* authDb
              .deleteFrom("app_public.playground_stars")
              .where("playground_hash", "=", hash)
              .returning("playground_hash");
            if (deleted.length > 0) {
              return { starred: false };
            }
            yield* authDb
              .insertInto("app_public.playground_stars")
              .values({ playground_hash: hash });
            return { starred: true };
          }),
        ),

      deletePlayground: (sessionId: string, hash: string) =>
        withAuthContext(
          authDb,
          sessionId,
          authDb
            .deleteFrom("app_public.playgrounds")
            .where("hash", "=", hash)
            .returning("hash")
            .pipe(Effect.head),
        ),
    } as const;
  }),
  dependencies: [PgAuthDB.Live],
  accessors: true,
}) { }

export const runPlaygroundService = <A, E>(effect: Effect.Effect<A, E, PlaygroundService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(PlaygroundService.Default)));
