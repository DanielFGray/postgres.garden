import { Context, Effect, Layer, pipe } from "effect";
import * as S from "effect/Schema";
import { sql, type Selectable } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";
import { runQuery, visitorQuerier, type KyselyDB, type Step } from "../db.js";
import { CurrentSession } from "../apiSchema.js";
import type { AppPublicPlaygrounds } from "../../generated/db.js";
import { Secrets } from "../secrets.js";
import { parseSearchDSL } from "lib/searchDSL.js";
import { publicOnly, publicOrOwn } from "./playgroundVisibility.js";
import type { Privacy } from "../models.js";

export interface ListPlaygroundsQuery {
  readonly offset?: number | null;
  readonly limit?: number | null;
  readonly sort?: "created_at" | "updated_at" | "stars" | null;
}

export interface CreatePlaygroundInput {
  readonly name?: string | null;
  readonly message: string;
  readonly description?: string | null;
  readonly privacy?: typeof Privacy.Type;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly activeFile?: string | null;
}

export interface UpdatePlaygroundInput {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly privacy?: typeof Privacy.Type | null;
}

export interface CommitPayload {
  readonly message: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly activeFile?: string | null;
}

/**
 * Lift a flat `username` column into the nested `user` object the API contract
 * expects, collapsing the anonymous case to a null user rather than a user with
 * a null name.
 *
 * Playgrounds may have no owner (anonymous pastes), so the queries left-join
 * users. Shaping the object in SQL would type it `{ username: string | null }`,
 * because the query builder cannot see that a present user row implies a
 * present name. Narrowing here in TypeScript proves it instead of asserting it.
 */
const nestUser = <T extends { readonly username: string | null }>({
  username,
  ...row
}: T): Omit<T, "username"> & { readonly user: { readonly username: string } | null } => ({
  ...row,
  user: username === null ? null : { username },
});

/** One row of `app_public.playground_commit_result`. */
interface CommitResultRow {
  readonly commit_id: string;
  readonly playground_hash: string;
  readonly parent_id: string | null;
  readonly message: string;
  readonly created_at: Date;
}

/** The files of one save, in the form the commit functions store. */
const encodeCommitData = (body: CommitPayload) =>
  S.encodeEffect(S.fromJsonString(S.Unknown))({
    files: body.files,
    activeFile: body.activeFile,
  });

/**
 * Add a commit to a playground. The function refuses a playground the caller
 * neither owns nor holds the key to, so it is also the authorization check.
 */
const commitTo = (
  authDb: KyselyDB,
  commit: {
    readonly hash: string;
    readonly message: string;
    readonly data: string;
    readonly editKeyHash?: Buffer | null;
  },
) =>
  runQuery(
    authDb
      .selectFrom(
        // Named arguments: the function has seven parameters, six of them with
        // defaults, so a positional call says which value is which only by
        // counting. A commit to an existing playground names neither its
        // privacy nor its name, which the playground already has.
        sql<CommitResultRow>`app_public.create_playground_commit(
          p_playground_name => ${null},
          p_commit_message => ${commit.message},
          p_commit_data => ${commit.data}::jsonb,
          p_playground_hash => ${commit.hash},
          p_edit_key_hash => ${commit.editKeyHash ?? null}::bytea
        )`.as("result"),
      )
      .selectAll(),
  ).pipe(
    Effect.head,
    Effect.catchTag("NoSuchElementError", () =>
      Effect.die(new Error("create_playground_commit returned no rows")),
    ),
  );

/**
 * Copy a playground into a new one the caller owns, whose first commit holds
 * the source's latest commit.
 */
const forkFrom = (
  authDb: KyselyDB,
  source: { readonly hash: string; readonly name: string | null },
) =>
  runQuery(
    authDb
      .selectFrom((eb) =>
        eb
          .fn<CommitResultRow>("app_public.fork_playground", [
            eb.val(source.hash),
            eb.val(source.name),
          ])
          .as("result"),
      )
      .selectAll(),
  ).pipe(
    Effect.head,
    Effect.catchTag("NoSuchElementError", () =>
      Effect.die(new Error("fork_playground returned no rows")),
    ),
  );

/**
 * @effect-expect-leaking CurrentSession
 *
 * `CurrentSession` differs per HTTP request, so unlike `AuthPool` it cannot
 * be resolved once when this service's Layer is built — it is deliberately
 * threaded through as a per-call requirement, the same way `HttpServerRequest`
 * would be.
 */
export class PlaygroundService extends Context.Service<PlaygroundService>()("PlaygroundService", {
  make: Effect.gen(function* () {
    const run = yield* visitorQuerier;
    const secrets = yield* Secrets;
    const asVisitor =<A, E = never, R = never>(use: (authDb: KyselyDB) => Step<A, E, R>) =>
      Effect.flatMap(CurrentSession, ({ session }) => run(session?.id, use));

    return {
      listForUser: (username: string, query: ListPlaygroundsQuery) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom("app_public.playgrounds as p")
            .innerJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<bigint>().as("stars")])
                  .groupBy("playground_hash")
                  .as("star_counts"),
              (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
            )
            .orderBy(sql.ref(query.sort ?? "created_at"), query.sort === "stars" ? "desc" : "desc")
            .limit(query.limit ?? 50)
            .where("u.username", "=", username)
            .where(publicOrOwn)
            .select((eb) => [
              "p.hash",
              "p.fork_hash",
              "p.name",
              "p.description",
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit(0n)).as("stars"),
              "p.created_at",
              "p.updated_at",
            ]),
        ),

      list: (query: ListPlaygroundsQuery) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom("app_public.playgrounds as p")
            .leftJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<bigint>().as("stars")])
                  .groupBy("playground_hash")
                  .as("star_counts"),
              (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
            )
            .orderBy(sql.ref(query.sort ?? "created_at"), query.sort === "stars" ? "desc" : "desc")
            .limit(query.limit ?? 50)
            .where(publicOnly)
            .select((eb) => [
              "p.hash",
              "p.fork_hash",
              "p.name",
              "p.description",
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit(0n)).as("stars"),
              "p.created_at",
              "p.updated_at",
              "u.username",
            ]),
        ).pipe(Effect.map((rows) => rows.map(nestUser))),

      search: (q: string, limit?: number, offset?: number) => {
        const parsed = parseSearchDSL(q);
        // `starred:` narrows to the caller's own stars, so it only means
        // anything when somebody is logged in.
        return Effect.flatMap(CurrentSession, ({ session }) =>
          run(session?.id, (authDb) =>
            runQuery(
              pipe(
                authDb
                  .selectFrom("app_public.playgrounds as p")
                  .leftJoin("app_public.users as u", "p.user_id", "u.id")
                  .leftJoin(
                    (eb) =>
                      eb
                        .selectFrom("app_public.playground_stars")
                        .select((eb) => ["playground_hash", eb.fn.countAll<bigint>().as("stars")])
                        .groupBy("playground_hash")
                        .as("star_counts"),
                    (join) => join.onRef("star_counts.playground_hash", "=", "p.hash"),
                  )
                  .orderBy(sql.ref(parsed.sort), "desc")
                  .limit(limit ?? 50)
                  .offset(offset ?? 0),
                (q) =>
                  parsed.starred && session
                    ? q.innerJoin("app_public.playground_stars as my_stars", (join) =>
                        join
                          .onRef("my_stars.playground_hash", "=", "p.hash")
                          .on("my_stars.user_id", "=", sql`app_public.current_user_id()`),
                      )
                    : q,
                (q) => (parsed.username ? q.where("u.username", "=", parsed.username) : q),
                (q) => q.where(publicOrOwn),
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
                    eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit(0n)).as("stars"),
                    "p.created_at",
                    "p.updated_at",
                    "u.username",
                  ]),
              ),
            ).pipe(Effect.map((rows) => rows.map(nestUser))),
          ),
        );
      },

      /**
       * Start a playground. A caller with no account gets a key back: it is
       * the only way to commit to this playground again, and the only way to
       * claim it later, so the answer carries it once and the database stores
       * nothing the key can be read out of.
       */
      create: Effect.fnUntraced(function* (body: CreatePlaygroundInput) {
        const { user } = yield* CurrentSession;
        const editKey = user === null ? yield* secrets.generate : null;
        const editKeyHash = editKey === null ? null : yield* secrets.digest(editKey);

        const commitData = yield* encodeCommitData(body);

        const { result, expires_at } = yield* asVisitor((authDb) =>
          Effect.gen(function* () {
            const result = yield* runQuery(
              authDb
                .selectFrom(
                  sql<{
                    commit_id: string;
                    playground_hash: string;
                    parent_id: string | null;
                    message: string;
                    created_at: Date;
                    // `p_privacy` is the privacy the caller asked for; NULL
                    // means it asked for none and the function keeps its
                    // default. Entitlement is the database's call: the
                    // _200_privacy_entitlement trigger refuses 'private' for an
                    // anonymous or non-sponsor author, and that reaches the
                    // client as a 400 carrying the trigger's own message.
                  }>`app_public.create_playground_commit(
                p_playground_name => ${body.name ?? null},
                p_commit_message => ${body.message},
                p_commit_data => ${commitData}::jsonb,
                p_playground_description => ${body.description ?? null},
                p_privacy => ${body.privacy ?? null}::app_public.privacy,
                p_edit_key_hash => ${editKeyHash}::bytea
              )`.as("result"),
                )
                .selectAll(),
            ).pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementError", () =>
                Effect.die(new Error("create_playground_commit returned no rows")),
              ),
            );

            // An unclaimed playground is pruned, so the author has to be told
            // when the link stops working. The row is the only place that date
            // exists: the retention it is calculated from depends on the size.
            const row = yield* runQuery(
              authDb
                .selectFrom("app_public.playgrounds")
                .select("expires_at")
                .where("hash", "=", result.playground_hash),
            ).pipe(
              Effect.head,
              Effect.catchTag("NoSuchElementError", () =>
                Effect.die(new Error("the playground just created cannot be read back")),
              ),
            );

            return { result, expires_at: row.expires_at };
          }),
        );

        return { ...result, edit_key: editKey, expires_at };
      }),

      /**
       * Hand an anonymous playground to the caller's account. The key stops
       * being the way in, and the playground stops expiring.
       */
      claim: Effect.fnUntraced(function* (hash: string, editKey: string | null) {
        // A claim with no key is a claim with nothing to redeem. The digest of
        // nothing is not null, so there is no digest to take: the function is
        // handed null and refuses, the same as it does for a key that is wrong.
        const editKeyHash = editKey === null ? null : yield* secrets.digest(editKey);

        return yield* asVisitor((authDb) =>
          runQuery(
            authDb
              .selectFrom(
                sql<
                  Selectable<AppPublicPlaygrounds>
                >`app_public.claim_playground(${hash}, ${editKeyHash}::bytea)`.as("claimed"),
              )
              // The columns the contract answers with. The function returns the
              // whole row, and the row holds the digest of the key that was
              // just spent: naming the columns keeps it on this side.
              .select([
                "hash",
                "head_commit_id",
                "user_id",
                "fork_hash",
                "privacy",
                "created_at",
                "updated_at",
                "name",
                "description",
                "data_size",
                "expires_at",
              ]),
          ).pipe(
            Effect.head,
            Effect.catchTag("NoSuchElementError", () =>
              Effect.die(new Error("claim_playground returned no rows")),
            ),
          ),
        );
      }),

      getByHash: (hash: string) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom("app_public.playgrounds as p")
            .leftJoin("app_public.users as u", "p.user_id", "u.id")
            .leftJoin("app_public.playgrounds as fork_parent", "p.fork_hash", "fork_parent.hash")
            .leftJoin("app_public.users as fork_owner", "fork_parent.user_id", "fork_owner.id")
            .leftJoin(
              (eb) =>
                eb
                  .selectFrom("app_public.playground_stars")
                  .select((eb) => ["playground_hash", eb.fn.countAll<bigint>().as("stars")])
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
              "u.username",
              eb.fn.coalesce(eb.ref("star_counts.stars"), sql.lit(0n)).as("stars"),
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
            .where("p.hash", "=", hash),
        ).pipe(Effect.head, Effect.map(nestUser)),

      fork: (hash: string, name: string | null | undefined) =>
        asVisitor((authDb) => forkFrom(authDb, { hash, name: name ?? null })),

      update: Effect.fnUntraced(function* (
        hash: string,
        input: UpdatePlaygroundInput,
        editKey: string | null,
      ) {
        const editKeyHash = editKey === null ? null : yield* secrets.digest(editKey);
        // The patch says which fields to change by which keys it carries, so a
        // field the caller left out keeps its value and one they sent as null
        // is cleared. Dropping the absent keys here is what makes that true.
        const patch = Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        );

        return yield* asVisitor((authDb) =>
          runQuery(
            authDb
              .selectFrom(
                sql<Selectable<AppPublicPlaygrounds>>`app_public.update_playground(
                  ${hash},
                  ${JSON.stringify(patch)}::jsonb,
                  ${editKeyHash}::bytea
                )`.as("updated"),
              )
              // The columns the contract answers with: the row carries the
              // digest of the key that authorised this write, and naming the
              // columns keeps it on this side.
              .select([
                "hash",
                "head_commit_id",
                "user_id",
                "fork_hash",
                "privacy",
                "created_at",
                "updated_at",
                "name",
                "description",
                "data_size",
                "expires_at",
              ]),
          ),
        ).pipe(Effect.head);
      }),

      createCommit: (
        userId: string | null,
        hash: string,
        body: CommitPayload,
        editKey: string | null,
      ) =>
        asVisitor((authDb) =>
          Effect.gen(function* () {
            if (userId === null) {
              // Without an account the key is the whole claim to this
              // playground, and the database refuses a commit whose key does
              // not match. There is no fork to fall back to: a fork needs an
              // owner to belong to.
              const editKeyHash = editKey === null ? null : yield* secrets.digest(editKey);
              const data = yield* encodeCommitData(body);
              return {
                ...(yield* commitTo(authDb, {
                  hash,
                  message: body.message,
                  data,
                  editKeyHash,
                })),
                forked: false as const,
              };
            }

            const playground = yield* runQuery(
              authDb
                .selectFrom("app_public.playgrounds")
                .select(["hash", "name", "user_id"])
                .where("hash", "=", hash),
            ).pipe(Effect.head);

            const data = yield* encodeCommitData(body);

            if (playground.user_id === userId) {
              return {
                ...(yield* commitTo(authDb, { hash, message: body.message, data })),
                forked: false as const,
              };
            }

            // Saving a playground that is not the caller's forks it, and the
            // work being saved lands on top of the copy. The fork's first commit
            // is the source as it stands, so the copy records what it came from
            // and still keeps the changes that prompted it. This holds for an
            // admin too: the editor never writes into someone else's playground.
            const fork = yield* forkFrom(authDb, { hash, name: playground.name });
            return {
              ...(yield* commitTo(authDb, {
                hash: fork.playground_hash,
                message: body.message,
                data,
              })),
              forked: true as const,
            };
          }),
        ),

      listCommits: (hash: string) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom("app_public.playground_commits as c")
            .leftJoin("app_public.users as u", "c.user_id", "u.id")
            .select(["c.id", "c.message", "c.created_at", "c.parent_id", "c.user_id", "u.username"])
            .where("c.playground_hash", "=", hash)
            .orderBy("c.created_at", "desc"),
        ).pipe(
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

      getCommit: (hash: string, commitId: string) =>
        asVisitor((authDb) =>
          authDb
            .selectFrom("app_public.playground_commits")
            .select(["id", "message", "data", "created_at", "playground_hash", "parent_id"])
            .where("id", "=", commitId)
            .where("playground_hash", "=", hash),
        ).pipe(
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

      getCommitHistory: (hash: string, commitId: string, limit = 50) =>
        asVisitor((authDb) =>
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
            .orderBy("depth", "asc"),
        ).pipe(
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

      getCommitDiff: (hash: string, commitId: string) =>
        asVisitor((authDb) =>
          Effect.gen(function* () {
            const commit = yield* runQuery(
              authDb
                .selectFrom("app_public.playground_commits")
                .select(["id", "parent_id", "data"])
                .where("id", "=", commitId)
                .where("playground_hash", "=", hash),
            ).pipe(Effect.head);

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

            const parentCommit = yield* runQuery(
              authDb
                .selectFrom("app_public.playground_commits")
                .select(["data"])
                .where("id", "=", commit.parent_id),
            ).pipe(Effect.head);

            const parentData = (parentCommit.data as {
              files: Array<{ path: string; content: string }>;
            }) || { files: [] };
            const parentFiles = parentData.files;

            const currentFileMap = new Map(currentFiles.map((f) => [f.path, f.content]));
            const parentFileMap = new Map(parentFiles.map((f) => [f.path, f.content]));

            const added = currentFiles.filter((f) => !parentFileMap.has(f.path));
            const modified = currentFiles.flatMap((f) => {
              const parentContent = parentFileMap.get(f.path);
              return parentContent !== undefined && parentContent !== f.content
                ? [{ ...f, parentContent }]
                : [];
            });
            const deleted = parentFiles.filter((f) => !currentFileMap.has(f.path));

            return { isRootCommit: false, added, modified, deleted };
          }),
        ),

      toggleStar: (hash: string) =>
        asVisitor((authDb) =>
          Effect.gen(function* () {
            const deleted = yield* runQuery(
              authDb
                .deleteFrom("app_public.playground_stars")
                .where("playground_hash", "=", hash)
                .returning("playground_hash"),
            );
            if (deleted.length > 0) {
              return { starred: false };
            }
            yield* runQuery(
              authDb.insertInto("app_public.playground_stars").values({ playground_hash: hash }),
            );
            return { starred: true };
          }),
        ),

      deletePlayground: (hash: string) =>
        asVisitor((authDb) =>
          authDb.deleteFrom("app_public.playgrounds").where("hash", "=", hash).returning("hash"),
        ).pipe(Effect.head),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Secrets.layer));
}
