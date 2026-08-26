import { type ExpressionBuilder, Kysely, PostgresDialect, Selectable, sql } from "kysely";
import { Elysia, t } from "elysia";
import { cookie } from "@elysiajs/cookie";
import pg from "pg";
import { Effect, Layer, Random } from "effect";
import { valkey } from "./valkey.js";
import { env } from "./assertEnv.js";
import type { DB, AppPublicUsers as User } from "../generated/db.js";
import {
  SessionService,
  sessionCookieName,
  buildSessionCookie,
} from "./services/sessionService.js";
import { DatabaseLive } from "./db.js";

const publicUrl = env.VITE_ROOT_URL.replace(/\/$/, "");

const resolveRedirectLocation = (target: string) =>
  target.startsWith("http") ? target : new URL(target, `${publicUrl}/`).toString();

// Raw Kysely instance for test helpers (test-only, never in production)
const rootDb = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: env.DATABASE_URL }),
  }),
});

const createSession = (userId: string) =>
  Effect.runPromise(
    SessionService.createSession(userId).pipe(
      Effect.provide(SessionService.Default.pipe(Layer.provideMerge(DatabaseLive))),
    ),
  );

if (env.NODE_ENV === "production") {
  throw new Error("testing helpers must not run in production mode");
}

export const testingServer = new Elysia({ prefix: "/api/testing" })
  .use(cookie({ secret: env.SECRET }))
  .onError((ctx) => {
    void Effect.runPromise(Effect.logError(ctx.error));
    return { error: "Internal Server Error" };
  })
  .get("/clearTestUsers", () =>
    rootDb
      .deleteFrom("app_public.users")
      .where("username", "like", "test%")
      .execute()
      .then(() =>
        valkey
          .keys("session:*")
          .then((keys) => (keys.length > 0 ? valkey.del(...keys) : undefined))
          .then(() => ({ success: true })),
      ),
  )
  .get(
    "/login",
    ({ query, cookie, redirect }) =>
      reallyCreateUser({
        username: query.username,
        email: query.email,
        verified: query.verified === "true",
        password: query.password,
      }).then(({ session }) => {
        cookie[sessionCookieName]?.set(buildSessionCookie(session.token, session.expiresAt));
        return redirect(resolveRedirectLocation(query.redirectTo ?? "/"));
      }),
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
    ({ body, cookie, redirect }) => {
      const { username, email, password, redirectTo } = body;

      return sql<Selectable<User>>`
          select u.* from app_private.really_create_user(
            username => ${username}::citext,
            email => ${email}::citext,
            email_is_verified => false,
            password => ${password}::text
          ) u
          where not (u is null);
        `
        .execute(rootDb)
        .then(({ rows: [user] }) => {
          if (!user?.id) throw new Error("Registration failed");
          return createSession(user.id).then(({ token, expiresAt }) => {
            cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));
            return redirect(resolveRedirectLocation(redirectTo ?? "/"));
          });
        })
        .catch((error) => {
          if (error instanceof pg.DatabaseError && error.code === "23505") {
            throw new Error("Username already exists", { cause: error });
          }
          throw new Error("Registration failed", { cause: error });
        });
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
    ({ body, cookie, redirect }) => {
      const { id, password, redirectTo } = body;

      return sql<Selectable<User>>`
        select u.* from app_private.login(${id}::citext, ${password}) u
        where not (u is null)
      `
        .execute(rootDb)
        .then(({ rows: [user] }) => {
          if (!user?.id) throw new Error("Invalid credentials");
          return createSession(user.id).then(({ token, expiresAt }) => {
            cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));
            return redirect(resolveRedirectLocation(redirectTo ?? "/"));
          });
        });
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
    ({ query }) =>
      reallyCreateUser({
        username: query.username,
        email: query.email,
        verified: query.verified === "true",
        password: query.password,
      }).then(({ user }) => {
        const email = query.email ?? `${query.username ?? "testuser"}@example.com`;
        return getUserEmailSecrets(email).then((userEmailSecrets) => ({
          user,
          userEmailId: userEmailSecrets.user_email_id,
          verificationToken: query.verified ? null : userEmailSecrets.verification_token,
        }));
      }),
    {
      query: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        verified: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        password: t.Optional(t.String()),
      }),
    },
  )
  .get("/getUserSecrets", ({ query }) => getUserSecrets(query.username ?? "testuser"), {
    query: t.Object({ username: t.Optional(t.String()) }),
  })
  .get("/getEmailSecrets", ({ query }) => getUserEmailSecrets(query.email), {
    query: t.Object({ email: t.String() }),
  })
  .get(
    "/verifyUser",
    ({ query }) => {
      return rootDb
        .updateTable("app_public.users")
        .set({ is_verified: true })
        .where("username", "=", query.username ?? "testuser")
        .execute()
        .then(() => ({ success: true }));
    },
    { query: t.Object({ username: t.Optional(t.String()) }) },
  );

function reallyCreateUser({
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
  const random = username == null ? Effect.runPromise(Random.next) : Promise.resolve(0);
  return random.then((randomValue) => {
    const resolvedUsername = username ?? `testuser_${randomValue.toString(36).slice(2, 10)}`;
    const resolvedEmail = email ?? `${resolvedUsername}@example.com`;
    return sql<Selectable<User>>`
    select u.* from app_private.really_create_user(
      username => ${resolvedUsername}::citext,
      email => ${resolvedEmail}::citext,
      email_is_verified => ${verified},
      password => ${password}::text
    ) u
    where not (u is null);
    `
      .execute(rootDb)
      .then(({ rows: [user] }) => {
        if (!user?.id) throw new Error("Failed to create test user");
        return createSession(user.id).then((session) => ({ user, session }));
      });
  });
}

function getUserSecrets(username: string) {
  return rootDb
    .selectFrom("app_private.user_secrets")
    .selectAll()
    .where("user_id", "=", (eb: ExpressionBuilder<DB, "app_private.user_secrets">) =>
      eb.selectFrom("app_public.users").select("id").where("username", "=", username),
    )
    .executeTakeFirst()
    .then((secrets) => {
      if (!secrets) {
        throw new Error("User secrets not found");
      }
      return secrets;
    });
}

function getUserEmailSecrets(email: string) {
  return rootDb
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
    .executeTakeFirst()
    .then((secrets) => {
      if (!secrets) {
        throw new Error("User email secrets not found");
      }
      return secrets;
    });
}
