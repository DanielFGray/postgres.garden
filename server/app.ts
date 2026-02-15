import * as pg from "pg";
import { Elysia } from "elysia";
import { cookie } from "@elysiajs/cookie";
import { sql, type Selectable } from "kysely";
import { jsonBuildObject } from "kysely/helpers/postgres";
import * as arctic from "arctic";
import "./assertEnv";
import { rootDb, withAuthContext, handleDbError } from "./db.js";
import { env } from "./assertEnv.js";
import * as S from "effect/Schema";
import { templateHack } from "lib/index.js";
import {
  sessionCookieName,
  createSession,
  validateSessionToken,
  buildSessionCookie,
  deleteSession,
} from "./sessions.js";
import type { AppPublicUsers, AppPublicUserEmails } from "generated/db";

const gql = templateHack;
const html = templateHack;

const PositiveNumber = S.Number.pipe(
  S.filter((n) => n > 0 || "a positive number"),
);
const LessThan = <T extends number>(than: number) =>
  S.filter<S.Schema<T, T>>((n) => n < than || "a number less than 100");

const getGithubSponsorInfo = gql`
  query ($user: String!, $repo: String!, $owner: String!) {
    repository(owner: $owner, name: $repo) {
      collaborators(query: $user) {
        totalCount
      }
    }
    user(login: $user) {
      isSponsoringViewer
      isViewer
      sponsorshipForViewerAsSponsorable {
        isActive
        isOneTimePayment
        tier {
          name
          monthlyPriceInDollars
        }
      }
    }
  }
`;

const apiRoutes = new Elysia({ prefix: "/api" })
  .use(cookie({ secret: env.SECRET }))

  .derive(async ({ cookie }) => {
    const rawCookie = cookie[sessionCookieName]?.value as string | undefined;
    const { user, session } = await validateSessionToken(rawCookie);
    return { user, session };
  })

  .post("/logout", async ({ status, cookie, session }) => {
    try {
      if (session) {
        await deleteSession(session.id);
      }
      // Clear the session cookie
      cookie[sessionCookieName]?.set({
        value: "",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: env.NODE_ENV === "production",
        path: "/",
        expires: new Date(0), // Expire immediately
      });
      return { success: true };
    } catch (e) {
      const { code, error } = handleDbError(e, "Logout failed");
      return status(code, { error });
    }
  })

  .get("/me", ({ user }) => ({ user }))

  .delete(
    "/me",
    async ({ query, user, status }) => {
      if (!user) return status(401, { error: "Unauthorized" });

      try {
        if (!query.token) {
          const result = await rootDb
            .selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.request_account_deletion", [])
                .as("request_account_deletion"),
            )
            .executeTakeFirst();
          return { success: result?.request_account_deletion === true };
        }
        const result = await rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.confirm_account_deletion", [
                eb.val(query.token),
              ])
              .as("confirm_account_deletion"),
          )
          .executeTakeFirst();
        return { success: result?.confirm_account_deletion === true };
      } catch (e) {
        const { code, error } = handleDbError(e, "Account deletion failed");
        return status(code, { error });
      }
    },
    {
      query: S.Struct({
        token: S.UndefinedOr(S.String),
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/forgotPassword",
    async ({ body, status }) => {
      try {
        await rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<void>("app_public.forgot_password", [
                sql`${body.email}::citext`,
              ])
              .as("forgot_password"),
          )
          .executeTakeFirst();
        return { success: true };
      } catch (e) {
        const { code, error } = handleDbError(
          e,
          "Failed to send password reset email",
        );
        return status(code, { error });
      }
    },
    {
      body: S.Struct({
        email: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/resetPassword",
    async ({ body, status }) => {
      try {
        const result = await rootDb
          .selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_private.reset_password", [
                sql`${body.userId}::uuid`,
                eb.val(body.token),
                eb.val(body.password),
              ])
              .as("reset_password"),
          )
          .executeTakeFirst();
        return { success: result?.reset_password === true };
      } catch (e) {
        const { code, error } = handleDbError(e, "Failed to reset password");
        return status(code, { error });
      }
    },
    {
      body: S.Struct({
        userId: S.UUID,
        token: S.String,
        password: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/changePassword",
    ({ body, session, status }) => {
      if (!session) return status(401, { error: "Unauthorized" });

      return withAuthContext(session.id, async (tx) => {
        try {
          const result = await tx
            .selectNoFrom((eb) =>
              eb
                .fn<boolean>("app_public.change_password", [
                  eb.val(body.oldPassword),
                  eb.val(body.newPassword),
                ])
                .as("change_password"),
            )
            .executeTakeFirst();
          return { success: result?.change_password === true };
        } catch (e) {
          const { code, error } = handleDbError(e, "Failed to change password");
          return status(code, { error });
        }
      });
    },
    {
      body: S.Struct({
        oldPassword: S.String,
        newPassword: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/verifyEmail",
    async ({ body }) => {
      const result = await rootDb
        .selectNoFrom((eb) =>
          eb
            .fn<boolean>("app_public.verify_email", [
              sql`${body.emailId}::uuid`,
              eb.val(body.token),
            ])
            .as("verify_email"),
        )
        .executeTakeFirst();
      return { success: result?.verify_email === true };
    },
    {
      body: S.Struct({
        emailId: S.UUID,
        token: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/makeEmailPrimary",
    ({ body, session, status }) => {
      if (!session) return status(401, { error: "Unauthorized" });

      return withAuthContext(session.id, async (tx) => {
        try {
          const result = await tx
            .selectFrom((eb) =>
              eb
                .fn<
                  Selectable<AppPublicUserEmails>
                >("app_public.make_email_primary", [sql`${body.emailId}::uuid`])
                .as("make_email_primary"),
            )
            .selectAll()
            .executeTakeFirstOrThrow();
          return result;
        } catch (e) {
          const { code, error } = handleDbError(
            e,
            "Failed to update primary email",
          );
          return status(code, { error });
        }
      });
    },
    { body: S.Struct({ emailId: S.UUID }).pipe(S.standardSchemaV1) },
  )

  .post(
    "/resendEmailVerificationCode",
    ({ body, session, status }) => {
      if (!session) return status(401, { error: "Unauthorized" });

      return withAuthContext(session.id, async (tx) => {
        const result = await tx
          .selectNoFrom((eb) =>
            eb
              .fn<boolean>("app_public.resend_email_verification_code", [
                sql`${body.emailId}::uuid`,
              ])
              .as("resend_email_verification_code"),
          )
          .executeTakeFirst();
        return { success: result?.resend_email_verification_code === true };
      });
    },
    { body: S.Struct({ emailId: S.UUID }).pipe(S.standardSchemaV1) },
  )

  .get(
    "/user/:username",
    ({ query, session, params }) =>
      withAuthContext(session?.id, async (tx) => {
        const result = await tx
          .selectFrom("app_public.playgrounds as p")
          .innerJoin("app_public.users as u", "p.user_id", "u.id")
          .crossJoinLateral((eb) =>
            eb
              .selectFrom("app_public.playground_stars as s")
              .select((eb) => [eb.fn.countAll().as("stars")])
              .where("playground_hash", "=", eb.ref("p.hash"))
              .as("get_stars"),
          )
          .orderBy(
            sql.ref(query.sort ?? "created_at"),
            query.sort === "stars" ? "desc" : "desc",
          )
          .limit(query.limit ?? 50)
          .where("u.username", "=", params.username)
          .select([
            "p.hash",
            "p.fork_hash",
            "p.name",
            "p.description",
            "stars",
            "p.created_at",
          ])
          .execute();
        return result;
      }),
    {
      params: S.Struct({
        username: S.String,
      }).pipe(S.standardSchemaV1),
      query: S.Struct({
        offset: S.NullishOr(PositiveNumber),
        limit: S.NullishOr(PositiveNumber.pipe(LessThan(100))),
        sort: S.NullishOr(S.Union(S.Literal("created_at"), S.Literal("stars"))),
      }).pipe(S.standardSchemaV1),
    },
  )

  .get(
    "/user/:username/playgrounds",
    ({ query, session, params }) =>
      withAuthContext(session?.id, async (tx) => {
        const playgrounds = await tx
          .selectFrom("app_public.playgrounds as p")
          .innerJoin("app_public.users as u", "p.user_id", "u.id")
          .crossJoinLateral((eb) =>
            eb
              .selectFrom("app_public.playground_stars as s")
              .select((eb) => [eb.fn.countAll().as("stars")])
              .where("playground_hash", "=", eb.ref("p.hash"))
              .as("get_stars"),
          )
          .orderBy(
            sql.ref(query.sort ?? "created_at"),
            query.sort === "stars" ? "desc" : "desc",
          )
          .limit(query.limit ?? 50)
          .where("u.username", "=", params.username)
          .groupBy("u.id")
          .selectAll("u")
          .select((eb) => [
            eb.fn
              .jsonAgg(
                jsonBuildObject({
                  hash: eb.ref("p.hash"),
                  fork_hash: eb.ref("p.fork_hash"),
                  name: eb.ref("p.name"),
                  description: eb.ref("p.description"),
                  stars: eb.ref("stars"),
                  created_at: eb.ref("p.created_at"),
                }),
              )
              .as("posts"),
          ])
          .execute();
        return playgrounds;
      }),
    {
      params: S.Struct({
        username: S.String,
      }).pipe(S.standardSchemaV1),
      query: S.Struct({
        offset: S.NullishOr(PositiveNumber),
        limit: S.NullishOr(PositiveNumber.pipe(LessThan(100))),
        sort: S.NullishOr(S.Union(S.Literal("created_at"), S.Literal("stars"))),
      }).pipe(S.standardSchemaV1),
    },
  )

  .get(
    "/playgrounds",
    ({ session, query }) =>
      withAuthContext(session?.id, async (tx) => {
        const result = await tx
          .selectFrom("app_public.playgrounds as p")
          .innerJoin("app_public.users as u", "p.user_id", "u.id")
          .crossJoinLateral((eb) =>
            eb
              .selectFrom("app_public.playground_stars as s")
              .select((eb) => [eb.fn.countAll().as("stars")])
              .where("playground_hash", "=", eb.ref("p.hash"))
              .as("get_stars"),
          )
          .orderBy(
            sql.ref(query.sort ?? "created_at"),
            query.sort === "stars" ? "desc" : "desc",
          )
          .limit(query.limit ?? 50)
          .select((eb) => [
            "p.hash",
            "p.fork_hash",
            "p.name",
            "p.description",
            "stars",
            "p.created_at",
            jsonBuildObject({ username: eb.ref("u.username") }).as("user"),
          ])
          .execute();
        return result;
      }),
    {
      query: S.Struct({
        offset: S.NullishOr(PositiveNumber),
        limit: S.NullishOr(PositiveNumber.pipe(LessThan(100))),
        sort: S.NullishOr(S.Union(S.Literal("created_at"), S.Literal("stars"))),
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/playgrounds",
    async ({ body, session, user, status }) => {
      if (!session || !user) return status(401, { error: "Unauthorized" });
      try {
        return await withAuthContext(session?.id, async (tx) => {
          // Call the Postgres function to atomically create playground + commit
          const result = await tx
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
            .executeTakeFirst();

          if (!result) {
            return status(500, { error: "Failed to create commit" });
          }

          return {
            commit_id: result.commit_id,
            playground_hash: result.playground_hash,
            parent_id: result.parent_id,
            message: result.message,
            created_at: result.created_at,
          };
        });
      } catch (e) {
        const { code, error } = handleDbError(e, "Failed to save workspace");
        return status(code, { error });
      }
    },
    {
      body: S.Struct({
        name: S.NullishOr(S.String),
        message: S.String,
        description: S.NullishOr(S.String),
        files: S.Array(
          S.Struct({
            path: S.String,
            content: S.String,
          }),
        ),
        activeFile: S.NullishOr(S.String),
      }).pipe(S.standardSchemaV1),
    },
  )
  .get(
    "/playgrounds/:hash",
    ({ params, session, status }) =>
      withAuthContext(session?.id, async (tx) => {
        const result = await tx
          .selectFrom("app_public.playgrounds as p")
          .leftJoin("app_public.users as u", "p.user_id", "u.id")
          // Join to get fork parent info
          .leftJoin(
            "app_public.playgrounds as fork_parent",
            "p.fork_hash",
            "fork_parent.hash",
          )
          .leftJoin(
            "app_public.users as fork_owner",
            "fork_parent.user_id",
            "fork_owner.id",
          )
          .crossJoinLateral((eb) =>
            eb
              .selectFrom("app_public.playground_stars as s")
              .select((eb) => [eb.fn.countAll().as("stars")])
              .where("playground_hash", "=", eb.ref("p.hash"))
              .as("get_stars"),
          )
          .selectAll("p")
          .select((eb) => [
            jsonBuildObject({ username: eb.ref("u.username") }).as("user"),
            "stars",
            // Include fork_of info when this is a forked playground
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
          .where("p.hash", "=", params.hash)
          .executeTakeFirst();
        if (!result) return status(404, { error: "playground not found" });
        return result;
      }),
    { params: S.Struct({ hash: S.String }).pipe(S.standardSchemaV1) },
  )

  .post(
    "/playgrounds/:hash/fork",
    async ({ params, body, session, user, status }) => {
      if (!session || !user) return status(401, { error: "Unauthorized" });
      try {
        return await withAuthContext(session.id, async (tx) => {
          const result = await tx
            .selectFrom(
              sql<{
                commit_id: string;
                playground_id: number;
                parent_id: string | null;
                message: string;
                created_at: Date;
              }>`app_public.fork_playground(
                ${params.hash},
                ${body.name ?? null}
              )`.as("result"),
            )
            .selectAll()
            .executeTakeFirstOrThrow();

          return {
            commit_id: result.commit_id,
            playground_id: result.playground_id,
            parent_id: result.parent_id,
            message: result.message,
            created_at: result.created_at,
          };
        });
      } catch (e) {
        if (e instanceof pg.DatabaseError && e.code === "23505") {
          return status(409, { error: "Fork name already exists" });
        }
        const { code, error } = handleDbError(e, "Failed to fork playground");
        return status(code, { error });
      }
    },
    {
      params: S.Struct({
        hash: S.String,
      }).pipe(S.standardSchemaV1),
      body: S.Struct({
        name: S.NullishOr(S.String),
      }).pipe(S.standardSchemaV1),
    },
  )

  .put(
    "/playgrounds/:hash",
    async ({ params, body, session, user, status }) => {
      if (!session || !user) return status(401, { error: "Unauthorized" });

      // Private playgrounds require sponsor/pro/admin role
      if (
        body.privacy === "private" &&
        !["sponsor", "pro", "admin"].includes(user.role)
      ) {
        return status(403, {
          error: "Private playgrounds require a sponsor account",
        });
      }

      return await withAuthContext(session.id, async (tx) => {
        let query = tx
          .updateTable("app_public.playgrounds")
          .where("hash", "=", params.hash);

        if (body.name !== undefined) {
          query = query.set("name", body.name);
        }
        if (body.description !== undefined) {
          query = query.set("description", body.description);
        }
        if (body.privacy != null) {
          query = query.set("privacy", body.privacy);
        }

        const result = await query.returningAll().executeTakeFirst();

        if (!result) return status(404, { error: "Playground not found" });
        return result;
      });
    },
    {
      params: S.Struct({ hash: S.String }).pipe(S.standardSchemaV1),
      body: S.Struct({
        name: S.NullishOr(S.String),
        description: S.NullishOr(S.String),
        privacy: S.NullishOr(
          S.Union(
            S.Literal("private"),
            S.Literal("secret"),
            S.Literal("public"),
          ),
        ),
      }).pipe(S.standardSchemaV1),
    },
  )

  .post(
    "/playgrounds/:hash/commits",
    async ({ params, body, session, user, status }) => {
      if (!session || !user) return status(401, { error: "Unauthorized" });

      try {
        return await withAuthContext(session.id, async (tx) => {
          const playgroundHash = params.hash;

          // Check playground ownership
          const playground = await tx
            .selectFrom("app_public.playgrounds")
            .select(["hash", "user_id"])
            .where("hash", "=", playgroundHash)
            .executeTakeFirst();

          if (!playground) {
            return status(404, { error: "Playground not found" });
          }

          // If playground is owned by current user, create a commit
          if (playground.user_id === user.id) {
            const result = await tx
              .selectFrom(
                sql<{
                  commit_id: string;
                  playground_hash: string;
                  parent_id: string | null;
                  message: string;
                  created_at: Date;
                }>`app_public.create_playground_commit(
                  ${null}, -- name (not needed for subsequent commits)
                  ${body.message},
                  ${JSON.stringify({ files: body.files, activeFile: body.activeFile })}::jsonb,
                  ${playgroundHash}, -- playground_hash
                  ${null} -- description (not needed for subsequent commits)
                )`.as("result"),
              )
              .selectAll()
              .executeTakeFirst();

            if (!result) {
              return status(500, { error: "Failed to create commit" });
            }

            return {
              commit_id: result.commit_id,
              playground_hash: result.playground_hash,
              parent_id: result.parent_id,
              message: result.message,
              created_at: result.created_at,
            };
          }

          // Playground is anonymous or owned by someone else - fork it
          const result = await tx
            .selectFrom(
              sql<{
                commit_id: string;
                playground_hash: string;
                parent_id: string | null;
                message: string;
                created_at: Date;
              }>`app_public.fork_playground(
                ${playgroundHash},
                ${`fork-of-${playgroundHash.substring(0, 8)}`}
              )`.as("result"),
            )
            .selectAll()
            .executeTakeFirst();

          if (!result) {
            return status(500, { error: "Failed to fork playground" });
          }

          return {
            commit_id: result.commit_id,
            playground_hash: result.playground_hash,
            parent_id: result.parent_id,
            message: result.message,
            created_at: result.created_at,
            forked: true, // Flag to indicate this was a fork
          };
        });
      } catch (e) {
        const { code, error } = handleDbError(e, "Failed to create commit");
        return status(code, { error });
      }
    },
    {
      params: S.Struct({
        hash: S.String,
      }).pipe(S.standardSchemaV1),
      body: S.Struct({
        message: S.String,
        files: S.Array(
          S.Struct({
            path: S.String,
            content: S.String,
          }),
        ),
        activeFile: S.NullishOr(S.String),
      }).pipe(S.standardSchemaV1),
    },
  )
  .get(
    "/playgrounds/:hash/commits",
    async ({ params, session, status }) => {
      try {
        return await withAuthContext(session?.id, async (tx) => {
          const playgroundHash = params.hash;
          const commits = await tx
            .selectFrom("app_public.playground_commits as c")
            .leftJoin("app_public.users as u", "c.user_id", "u.id")
            .select([
              "c.id",
              "c.message",
              "c.created_at",
              "c.parent_id",
              "c.user_id",
              "u.username",
            ])
            .where("c.playground_hash", "=", playgroundHash)
            .orderBy("c.created_at", "desc")
            .execute();

          return commits.map((commit) => ({
            id: commit.id,
            message: commit.message,
            timestamp: commit.created_at.getTime(),
            parent_id: commit.parent_id,
            user_id: commit.user_id,
            username: commit.username ?? undefined,
          }));
        });
      } catch (e) {
        console.error("Error fetching playground commits:", e);
        return status(500, { error: "Failed to fetch playground commits" });
      }
    },
    { params: S.Struct({ hash: S.String }).pipe(S.standardSchemaV1) },
  )
  .get(
    "/playgrounds/:hash/commits/:commit_id",
    async ({ params, session, status }) => {
      try {
        return await withAuthContext(session?.id, async (tx) => {
          const playgroundHash = params.hash;
          const commit = await tx
            .selectFrom("app_public.playground_commits")
            .select([
              "id",
              "message",
              "data",
              "created_at",
              "playground_hash",
              "parent_id",
            ])
            .where("id", "=", params.commit_id)
            .where("playground_hash", "=", playgroundHash)
            .executeTakeFirst();

          if (!commit) return status(404, { error: "Commit not found" });

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
        });
      } catch (e) {
        console.error("Error fetching commit:", e);
        return status(500, { error: "Failed to fetch commit" });
      }
    },
    {
      params: S.Struct({
        hash: S.String,
        commit_id: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )
  .get(
    "/playgrounds/:hash/commits/:commit_id/history",
    async ({ params, query, session, status }) => {
      try {
        return await withAuthContext(session?.id, async (tx) => {
          const playgroundHash = params.hash;
          const limit = query.limit || 50;

          // const result = await tx.withRecursive('commit_history', eb => eb
          //   .selectFrom('app_public.playground_commits')
          //   .select(eb => [
          //     'id',
          //     'message',
          //     'created_at',
          //     'parent_id',
          //     'playground_id',
          //     eb.lit(0).as('depth')
          //   ])
          //   .where('id', '=', params.commit_id)
          //   .where('playground_id', '=', params.hash)
          //   .unionAll(eb => eb
          //     .selectFrom('app_public.playground_commits as c')
          //     .innerJoin('commit_history as ch', 'c.id', 'ch.parent_id')
          //     .where('ch.depth', '<', limit - 1)
          //     .select(eb => [
          //       'c.id',
          //       'c.message',
          //       'c.created_at',
          //       'c.parent_id',
          //       'c.playground_id',
          //       eb('ch.depth', '+', eb.lit(1)).as('depth')
          //     ])
          //   )
          // )
          // .selectFrom('commit_history')
          // .selectAll()
          // .orderBy('depth', 'asc')
          // .execute()
          const result = await sql<{
            id: string;
            message: string;
            created_at: Date;
            parent_id: string | null;
            playground_id: number;
            depth: number;
          }>`
              WITH RECURSIVE commit_history AS (
                SELECT id, message, created_at, parent_id, playground_id, 0 AS depth
                FROM app_public.playground_commits
                WHERE id = ${params.commit_id} AND playground_id = ${playgroundHash}
                UNION ALL
                SELECT c.id, c.message, c.created_at, c.parent_id, c.playground_id, ch.depth + 1
                FROM app_public.playground_commits c
                JOIN commit_history ch ON c.id = ch.parent_id
                WHERE ch.depth < ${limit - 1}
              )
              SELECT * FROM commit_history ORDER BY depth ASC
            `.execute(tx);

          const history = result.rows.map((row) => ({
            id: row.id,
            message: row.message,
            timestamp: row.created_at.getTime(),
            parent_id: row.parent_id,
            playground_id: row.playground_id,
          }));

          const lastCommit = history[history.length - 1];
          const isComplete = !lastCommit || lastCommit.parent_id === null;

          return { history, isComplete };
        });
      } catch (e) {
        console.error("Error fetching commit history:", e);
        return status(500, { error: "Failed to fetch commit history" });
      }
    },
    {
      params: S.Struct({
        hash: S.String,
        commit_id: S.String,
      }).pipe(S.standardSchemaV1),
      query: S.Struct({ limit: S.NullishOr(S.Number) }).pipe(
        S.standardSchemaV1,
      ),
    },
  )
  .get(
    "/playgrounds/:hash/commits/:commit_id/diff",
    async ({ params, session, status }) => {
      try {
        return await withAuthContext(session?.id, async (tx) => {
          const playgroundHash = params.hash;
          const commit = await tx
            .selectFrom("app_public.playground_commits")
            .select(["id", "parent_id", "data"])
            .where("id", "=", params.commit_id)
            .where("playground_hash", "=", playgroundHash)
            .executeTakeFirst();

          if (!commit) return status(404, { error: "Commit not found" });

          const currentData = (commit.data as { files: Array<{ path: string; content: string }> }) || {
            files: [],
          };
          const currentFiles = currentData.files;

          if (!commit.parent_id) {
            return {
              isRootCommit: true,
              added: currentFiles,
              modified: [],
              deleted: [],
            };
          }

          const parentCommit = await tx
            .selectFrom("app_public.playground_commits")
            .select(["data"])
            .where("id", "=", commit.parent_id)
            .executeTakeFirst();

          if (!parentCommit)
            return status(404, { error: "Parent commit not found" });

          const parentData = (parentCommit.data as { files: Array<{ path: string; content: string }> }) || {
            files: [],
          };
          const parentFiles = parentData.files;

          const currentFileMap = new Map(
            currentFiles.map((f) => [f.path, f.content]),
          );
          const parentFileMap = new Map(
            parentFiles.map((f) => [f.path, f.content]),
          );

          const added = currentFiles.filter((f) => !parentFileMap.has(f.path));
          const modified = currentFiles.filter((f) => {
            const parentContent = parentFileMap.get(f.path);
            return parentContent !== undefined && parentContent !== f.content;
          });
          const deleted = parentFiles.filter(
            (f) => !currentFileMap.has(f.path),
          );

          return { isRootCommit: false, added, modified, deleted };
        });
      } catch (e) {
        console.error("Error generating commit diff:", e);
        return status(500, { error: "Failed to generate diff" });
      }
    },
    {
      params: S.Struct({
        hash: S.String,
        commit_id: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )

  .delete(
    "/playgrounds/:hash",
    async ({ params, session, status }) => {
      if (!session) return status(401, { error: "Unauthorized" });

      return await withAuthContext(session.id, async (tx) => {
        const result = await tx
          .deleteFrom("app_public.playgrounds")
          .where("hash", "=", params.hash)
          .returning("hash")
          .executeTakeFirst();

        if (!result) return status(404, { error: "Playground not found" });
        return { hash: result.hash };
      });
    },
    { params: S.Struct({ hash: S.String }).pipe(S.standardSchemaV1) },
  );

// Auth routes (without /api prefix)
const authRoutes = new Elysia()
  .use(cookie({ secret: env.SECRET }))
  .derive(async ({ cookie }) => {
    const rawCookie = cookie[sessionCookieName]?.value as string | undefined;
    const { user, session } = await validateSessionToken(rawCookie);
    return { user, session };
  })
  .post(
    "/register",
    async ({ body, cookie, status }) => {
      try {
        const {
          rows: [user],
        } = await sql<Selectable<AppPublicUsers>>`
          select u.* from app_private.really_create_user(
            username => ${body.username}::citext,
            email => ${body.email}::citext,
            email_is_verified => false,
            password => ${body.password}::text
          ) u
          where not (u is null);
        `.execute(rootDb);

        if (!user?.id) {
          return status(400, { error: "Registration failed" });
        }

        const { token, expiresAt } = await createSession(user.id);
        cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));

        return {
          id: user.id,
          username: user.username,
        };
      } catch (e) {
        if (e instanceof pg.DatabaseError && e.code === "23505") {
          return status(409, { error: "Username or email already exists" });
        }
        console.error("Registration error:", e);
        return status(500, { error: "Registration failed" });
      }
    },
    {
      body: S.Struct({
        username: S.String,
        email: S.String,
        password: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )
  .post(
    "/login",
    async ({ body, cookie, status }) => {
      try {
        const {
          rows: [user],
        } = await sql<Selectable<AppPublicUsers>>`
          select u.* from app_private.login(${body.id}::citext, ${body.password}) u
          where not (u is null)
        `.execute(rootDb);

        if (!user?.id) {
          return status(401, { error: "Invalid credentials" });
        }

        const { token, expiresAt } = await createSession(user.id);
        cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));

        return {
          id: user.id,
          username: user.username,
        };
      } catch (e) {
        console.error("Login error:", e);
        return status(500, { error: "Login failed" });
      }
    },
    {
      body: S.Struct({
        id: S.String,
        password: S.String,
      }).pipe(S.standardSchemaV1),
    },
  )
  .get("/me", ({ user }) => user)
  .post("/logout", async ({ status, cookie, session }) => {
    try {
      if (session) {
        await deleteSession(session.id);
      }
      cookie[sessionCookieName]?.set({
        value: "",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: env.NODE_ENV === "production",
        path: "/",
        expires: new Date(0),
      });
      return { success: true };
    } catch (e) {
      console.error("Logout error:", e);
      return status(500, { error: "Logout failed" });
    }
  });

if (!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)) {
  console.info(
    "GitHub OAuth is not configured: https://github.com/settings/developers",
  );
} else {
  const provider = new arctic.GitHub(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    `${env.VITE_ROOT_URL}/auth/github/callback`,
  );
  installOauthProvider({
    serviceName: "github",
    preRequestHook({ state }) {
      const url = provider.createAuthorizationURL(state, ["user:email"]);
      return { url };
    },
    async postRequestHook({ code }) {
      const tokens = await provider.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();

      // Fetch user profile
      const userResponse = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userJson: unknown = await userResponse.json();

      const userInformation = S.decodeUnknownSync(
        S.Struct({
          login: S.String,
          email: S.NullishOr(S.String),
          avatar_url: S.NullishOr(S.String),
          name: S.NullishOr(S.String),
        }),
        { onExcessProperty: "preserve" },
      )(userJson);

      // If email is not public, fetch from /user/emails endpoint
      let email = userInformation.email;
      if (!email) {
        const emailsResponse = await fetch(
          "https://api.github.com/user/emails",
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        const emails = S.decodeUnknownSync(
          S.Array(
            S.Struct({
              email: S.String,
              primary: S.Boolean,
              verified: S.Boolean,
            }),
          ),
        )(await emailsResponse.json());

        // Get primary verified email, or first verified email
        const primaryEmail = emails.find((e) => e.primary && e.verified);
        const verifiedEmail = emails.find((e) => e.verified);
        email = primaryEmail?.email ?? verifiedEmail?.email ?? null;
      }

      if (!email) {
        throw new Error(
          "Could not get email from GitHub. Please make sure you have a verified email on your GitHub account.",
        );
      }

      // Merge email into userInformation for the profile
      const profile = { ...userInformation, email };

      const { data: sponsorInfo } = S.decodeUnknownSync(
        S.Struct({
          data: S.NullOr(
            S.Struct({
              repository: S.Struct({
                collaborators: S.Struct({
                  totalCount: S.Number,
                }),
              }),
              user: S.Struct({
                isSponsoringViewer: S.Boolean,
                isViewer: S.Boolean,
                sponsorshipForViewerAsSponsorable: S.NullOr(
                  S.Struct({
                    isActive: S.Boolean,
                    isOneTimePayment: S.Boolean,
                    tier: S.Struct({
                      name: S.String,
                      monthlyPriceInDollars: S.Number,
                    }),
                  }),
                ),
              }),
            }),
          ),
        }),
      )(
        await (
          await fetch("https://api.github.com/graphql", {
            headers: { Authorization: `Bearer ${env.GITHUB_PAT}` },
            method: "POST",
            body: JSON.stringify({
              query: getGithubSponsorInfo,
              variables: {
                user: userInformation.login,
                owner: "danielfgray",
                repo: "postgres-playground",
              },
            }),
          })
        ).json(),
      );

      if (!sponsorInfo) {
        // TODO: retry logic
        throw new Error("Failed to fetch sponsor info from GitHub");
      }

      let role = "user";
      switch (true) {
        case sponsorInfo.user.isViewer:
          role = "admin";
          console.info("github user %s is admin", userInformation.login);
          break;
        case sponsorInfo.user.isSponsoringViewer:
          role = "sponsor";
          console.info("github user %s is sponsor", userInformation.login);
          break;
        case sponsorInfo.repository.collaborators.totalCount > 0:
          role = "sponsor";
          console.info("github user %s is collaborator", userInformation.login);
          break;
      }
      return {
        tokens,
        identifier: userInformation.login,
        profile: { ...profile, role },
      };
    },
  });
}

function installOauthProvider({
  serviceName,
  preRequestHook,
  postRequestHook,
}: {
  serviceName: string;
  preRequestHook: (_: { state: string }) => { url: URL };
  postRequestHook: (_: { code: string }) => Promise<{
    tokens: arctic.OAuth2Tokens;
    identifier: string;
    profile: unknown;
  }>;
}) {
  const cookieName = `${serviceName}_oauth_state` as const;
  authRoutes.get(`/auth/${serviceName}`, ({ cookie, query, redirect }) => {
    const state = arctic.generateState();
    const { url } = preRequestHook({ state });
    const redir = query.redirectTo?.toString();

    // Set the OAuth state cookie before redirecting
    cookie.redirectTo!.set({
      value: redir,
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10, // 10 minutes
    });

    // Set the OAuth state cookie before redirecting
    cookie[cookieName]!.set({
      value: state,
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10, // 10 minutes
    });

    return redirect(url.toString());
  });

  authRoutes.get(
    `/auth/${serviceName}/callback`,
    async ({
      cookie,
      session,
      user: currentUser,
      status,
      query: { code, state },
      set,
    }) => {
      const storedState = cookie[cookieName]?.value as string | undefined;
      if (!storedState || state !== storedState)
        return status(400, { error: "Invalid state parameter" });

      try {
        const { tokens, identifier, profile } = await postRequestHook({
          code,
        });
        // Use subquery to properly expand the composite type returned by the function
        const linkedUser = await rootDb
          .selectFrom(
            sql<Selectable<AppPublicUsers>>`app_private.link_or_register_user(
              f_user_id => ${currentUser?.id ?? null},
              f_service => ${serviceName},
              f_identifier => ${identifier},
              f_profile => ${JSON.stringify(profile)},
              f_auth_details => ${JSON.stringify(tokens)}
            )`.as("linked_user"),
          )
          .selectAll()
          .executeTakeFirst();

        if (!linkedUser || !linkedUser.id) {
          throw new Error("Failed to link or register user");
        }

        if (!session) {
          const { token, expiresAt } = await createSession(linkedUser.id);
          cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));
        }

        // Clear mode cookie after use
        cookie.oauth_mode?.remove();

        set.headers["content-type"] = "text/html; charset=utf-8";
        const authData = JSON.stringify({
          id: linkedUser.id,
          username: linkedUser.username,
          role: linkedUser.role,
        });
        return html`<!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1.0"
              />
              <title>Authentication Successful</title>
              <style>
                body {
                  font-family:
                    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                    Oxygen, Ubuntu, Cantarell, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  height: 100vh;
                  margin: 0;
                  background: #1e1e1e;
                  color: #cccccc;
                }
                .container {
                  text-align: center;
                  padding: 2rem;
                }
                .success-icon {
                  font-size: 4rem;
                  margin-bottom: 1rem;
                }
                h1 {
                  font-size: 1.5rem;
                  margin: 0 0 0.5rem 0;
                  color: #ffffff;
                }
                p {
                  margin: 0;
                  color: #cccccc;
                }
                .spinner {
                  display: inline-block;
                  width: 20px;
                  height: 20px;
                  border: 3px solid rgba(255, 255, 255, 0.3);
                  border-radius: 50%;
                  border-top-color: #007acc;
                  animation: spin 1s ease-in-out infinite;
                  margin-left: 0.5rem;
                }
                @keyframes spin {
                  to {
                    transform: rotate(360deg);
                  }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success-icon">✓</div>
                <h1>Authentication Successful!</h1>
                <p>Returning to the application<span class="spinner"></span></p>
              </div>
              <script>
                (function () {
                  const authData = ${authData};

                  try {
                    // Use localStorage as a communication channel since window.opener may be blocked after redirects
                    const storageKey = "github-auth-result";
                    const authResult = JSON.stringify({
                      type: "github-auth-success",
                      user: authData,
                      timestamp: Date.now(),
                    });

                    localStorage.setItem(storageKey, authResult);

                    // Also try BroadcastChannel if available
                    if (typeof BroadcastChannel !== "undefined") {
                      const channel = new BroadcastChannel("github-auth");
                      channel.postMessage({
                        type: "github-auth-success",
                        user: authData,
                      });
                      channel.close();
                    }

                    // Try window.opener as well (might work in some browsers)
                    if (window.opener && !window.opener.closed) {
                      try {
                        window.opener.postMessage(
                          {
                            type: "github-auth-success",
                            user: authData,
                          },
                          window.location.origin,
                        );
                      } catch (e) {
                        // Silently fail - localStorage method will work
                      }
                    }

                    // Trigger storage event by setting and removing a flag
                    localStorage.setItem(
                      "github-auth-trigger",
                      String(Date.now()),
                    );
                    localStorage.removeItem("github-auth-trigger");

                    document.querySelector("p").textContent =
                      "Authentication successful! Closing window...";

                    setTimeout(() => {
                      window.close();
                    }, 500);
                  } catch (error) {
                    console.error("Failed to communicate auth result:", error);
                    document.querySelector("p").textContent =
                      "Authentication successful! Please close this window.";
                  }
                })();
              </script>
            </body>
          </html>`;
      } catch (err) {
        if (
          err instanceof arctic.OAuth2RequestError &&
          err.message === "bad_verification_code"
        ) {
          return status(400, { error: "Bad verification code" });
        }
        const { code, error } = handleDbError(err, "OAuth error");
        return status(code, { error });
      }
    },
    {
      query: S.Struct({
        code: S.String,
        state: S.String,
        redirectTo: S.NullishOr(S.String),
      }).pipe(S.standardSchemaV1),
    },
  );
}

// Webhook routes (no session derive — signature-verified externally)
const webhookRoutes = new Elysia({ prefix: "/webhooks" }).post(
  "/gh_sponsor",
  async ({ request, status }) => {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return status(503, { error: "Webhook not configured" });
    }

    const { Webhooks } = await import("@octokit/webhooks");
    const webhooks = new Webhooks({ secret });

    const signature = request.headers.get("x-hub-signature-256");
    const body = await request.text();

    if (!signature || !(await webhooks.verify(body, signature))) {
      return status(401, { error: "Invalid signature" });
    }

    const event = request.headers.get("x-github-event");
    if (event !== "sponsorship") {
      return { ok: true };
    }

    const payload: unknown = JSON.parse(body);
    await rootDb
      .selectNoFrom((eb) =>
        eb
          .fn("graphile_worker.add_job", [
            eb.val("sponsor_webhook"),
            sql`${JSON.stringify(payload)}::json`,
          ])
          .as("add_job"),
      )
      .executeTakeFirst();

    return { ok: true };
  },
);

// Combined app with both API routes (/api prefix) and auth routes (no prefix)
export const app = new Elysia()
  .use(webhookRoutes)
  .use(authRoutes)
  .use(apiRoutes);

export type App = typeof app;
