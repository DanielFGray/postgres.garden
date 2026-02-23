import { type ExpressionBuilder, Kysely, PostgresDialect, Selectable, sql } from "kysely";
import { Elysia, t } from "elysia";
import { cookie } from "@elysiajs/cookie";
import pg from "pg";
import { Effect } from "effect";
import { valkey } from "./valkey.js";
import { env } from "./assertEnv.js";
import type { DB, AppPublicUsers as User } from "../generated/db.js";
import { SessionService, sessionCookieName, buildSessionCookie } from "./services/sessionService.js";

// Raw Kysely instance for test helpers (test-only, never in production)
const rootDb = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: env.DATABASE_URL }),
  }),
});

const createSession = (userId: string) =>
  Effect.runPromise(
    SessionService.createSession(userId).pipe(Effect.provide(SessionService.Default)),
  );

if (env.NODE_ENV === "production") {
  throw new Error("testing helpers must not run in production mode");
}

export const testingServer = new Elysia({ prefix: "/api/testingCommand" })
  .use(cookie({ secret: env.SECRET }))
  .onError((ctx) => {
    console.error(ctx.error);
    return { error: "Internal Server Error" };
  })
  .get("/clearTestUsers", async () => {
    await rootDb.deleteFrom("app_public.users").where("username", "like", "test%").execute();
    const keys = await valkey.keys("session:*");
    if (keys.length > 0) {
      await valkey.del(...keys);
    }
    return { success: true };
  })
  .get(
    "/login",
    async ({ query, cookie, redirect }) => {
      const { session } = await reallyCreateUser({
        username: query.username,
        email: query.email,
        verified: query.verified === "true",
        password: query.password,
      });

      cookie[sessionCookieName]?.set(buildSessionCookie(session.token, session.expiresAt));
      const target = query.redirectTo ?? "/";
      const location = target.startsWith("http")
        ? target
        : new URL(target, "http://localhost").toString();
      return redirect(location);
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        verified: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        password: t.Optional(t.String()),
        redirectTo: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/register",
    async ({ body, cookie, redirect }) => {
      const { username, email, password, redirectTo } = body;

      try {
        const {
          rows: [user],
        } = await sql<Selectable<User>>`
          select u.* from app_private.really_create_user(
            username => ${username}::citext,
            email => ${email}::citext,
            email_is_verified => false,
            password => ${password}::text
          ) u
          where not (u is null);
        `.execute(rootDb);

        if (!user?.id) throw new Error("Registration failed");
        const { token, expiresAt } = await createSession(user.id);
        cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));
        const target = redirectTo ?? "/";
        const location = target.startsWith("http")
          ? target
          : new URL(target, "http://localhost").toString();
        return redirect(location);
      } catch (error) {
        if (error instanceof pg.DatabaseError && error.code === "23505") {
          throw new Error("Username already exists", { cause: error });
        }
        throw new Error("Registration failed", { cause: error });
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String({ minLength: 8 }),
        email: t.String({ format: "email" }),
        redirectTo: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/loginPost",
    async ({ body, cookie, redirect }) => {
      const { id, password, redirectTo } = body;

      const {
        rows: [user],
      } = await sql<Selectable<User>>`
        select u.* from app_private.login(${id}::citext, ${password}) u
        where not (u is null)
      `.execute(rootDb);

      if (!user?.id) {
        throw new Error("Invalid credentials");
      }

      const { token, expiresAt } = await createSession(user.id);
      cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));
      const target = redirectTo ?? "/";
      const location = target.startsWith("http")
        ? target
        : new URL(target, "http://localhost").toString();
      return redirect(location);
    },
    {
      body: t.Object({
        id: t.String(),
        password: t.String(),
        redirectTo: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/createUser",
    async ({ query }) => {
      const { user } = await reallyCreateUser({
        username: query.username,
        email: query.email,
        verified: query.verified === "true",
        password: query.password,
      });

      const email = query.email ?? `${query.username ?? "testuser"}@example.com`;
      const userEmailSecrets = await getUserEmailSecrets(email);
      const verificationToken = query.verified ? null : userEmailSecrets.verification_token;

      return {
        user,
        userEmailId: userEmailSecrets.user_email_id,
        verificationToken,
      };
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        verified: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        password: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/getUserSecrets",
    async ({ query }) => {
      return getUserSecrets(query.username ?? "testuser");
    },
    { query: t.Object({ username: t.Optional(t.String()) }) },
  )
  .get(
    "/verifyUser",
    async ({ query }) => {
      const username = query.username ?? "testuser";
      await rootDb
        .updateTable("app_public.users")
        .set({ is_verified: true })
        .where("username", "=", username)
        .execute();
      return { success: true };
    },
    { query: t.Object({ username: t.Optional(t.String()) }) },
  );

async function reallyCreateUser({
  username,
  email,
  verified = false,
  password = "TestUserPassword",
}: {
  username?: string;
  email?: string;
  verified?: boolean;
  password?: string;
}) {
  const resolvedUsername = username ?? `testuser_${Math.random().toString(36).slice(2, 10)}`;
  const resolvedEmail = email ?? `${resolvedUsername}@example.com`;

  const {
    rows: [user],
  } = await sql<Selectable<User>>`
    select u.* from app_private.really_create_user(
      username => ${resolvedUsername}::citext,
      email => ${resolvedEmail}::citext,
      email_is_verified => ${verified},
      password => ${password}::text
    ) u
    where not (u is null);
  `.execute(rootDb);

  if (!user?.id) {
    throw new Error("Failed to create test user");
  }

  const session = await createSession(user.id);
  return { user, session };
}

async function getUserSecrets(username: string) {
  const secrets = await rootDb
    .selectFrom("app_private.user_secrets")
    .selectAll()
    .where("user_id", "=", (eb: ExpressionBuilder<DB, "app_private.user_secrets">) =>
      eb.selectFrom("app_public.users").select("id").where("username", "=", username),
    )
    .executeTakeFirst();
  if (!secrets) {
    throw new Error("User secrets not found");
  }
  return secrets;
}

async function getUserEmailSecrets(email: string) {
  const secrets = await rootDb
    .selectFrom("app_private.user_email_secrets")
    .selectAll()
    .where("user_email_id", "=", (eb: ExpressionBuilder<DB, "app_private.user_email_secrets">) =>
      eb
        .selectFrom("app_public.user_emails")
        .select("id")
        .where("email", "=", email)
        .orderBy("id", "desc")
        .limit(1),
    )
    .executeTakeFirst();

  if (!secrets) {
    throw new Error("User email secrets not found");
  }
  return secrets;
}
