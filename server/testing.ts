import { Selectable, sql } from "kysely";
import { Elysia, t } from "elysia";
import { cookie } from "@elysiajs/cookie";
import { edenFetch } from "@elysiajs/eden";
import pg from "pg";
import * as S from "effect/Schema";
import { rootDb } from "./db.js";
import { valkey } from "./valkey.js";
import { env } from "./assertEnv.js";
import { AppPublicUsers, AppPublicOrganizations } from "../generated/db.js";
import {
  sessionCookieName,
  createSession,
  buildSessionCookie,
  validateSessionToken,
} from "./sessions.js";

if (env.NODE_ENV === "production") {
  throw new Error("testing helpers must not run in production mode");
}

export const testingServer = new Elysia({ prefix: "/api/testingCommand" })
  .use(cookie({ secret: env.SECRET }))

  .onError((ctx) => {
    console.error(ctx.error);
    return { error: "Internal Server Error" };
  })

  .derive(async ({ cookie }) => {
    const rawCookie = cookie[sessionCookieName]?.value as string | undefined;
    const { user, session } = await validateSessionToken(rawCookie);
    return { user, session };
  })

  .get("/clearTestUsers", async () => {
    await rootDb
      .deleteFrom("app_public.users")
      .where("username", "like", "test%")
      .execute();
    // Clear orphaned Valkey sessions (test-only, safe to flush all)
    const keys = await valkey.keys("session:*");
    if (keys.length > 0) await valkey.del(...keys);
    return { success: true };
  })

  .get("/clearTestOrganizations", async () => {
    await rootDb
      .deleteFrom("app_public.organizations")
      .where("slug", "like", "test%")
      .execute();
    return { success: true };
  })

  .get(
    "/login",
    async ({ query, cookie, redirect }) => {
      // Parse orgs if it's a JSON string (from query parameter)
      const OrgsSchema = S.Array(S.Tuple(S.String, S.String, S.optionalElement(S.Boolean)));
      let orgs: [string, string, boolean?][] | undefined;
      if (query.orgs) {
        try {
          const raw: unknown = typeof query.orgs === "string"
            ? JSON.parse(query.orgs)
            : query.orgs;
          orgs = S.decodeUnknownSync(OrgsSchema)(raw) as [string, string, boolean?][];
        } catch (e) {
          console.error("Failed to parse orgs parameter:", e);
          orgs = undefined;
        }
      }

      const { session } = await reallyCreateUser({
        username: query.username,
        email: query.email,
        verified: query.verified === "true" ? true : false,
        name: query.name,
        avatarUrl: query.avatarUrl,
        password: query.password,
        orgs,
      });

      // Set session cookie
      cookie[sessionCookieName]?.set(
        buildSessionCookie(session.token, session.expiresAt),
      );

      // Delay required for GitHub actions (from original Express implementation)
      await new Promise((resolve) => setTimeout(resolve, 500));

      return redirect(query.redirectTo || "/");
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        verified: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        name: t.Optional(t.String()),
        avatarUrl: t.Optional(t.String()),
        password: t.Optional(t.String()),
        redirectTo: t.Optional(t.String()),
        orgs: t.Optional(t.String()), // Accept as string, parse manually
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
        } = await sql<Selectable<AppPublicUsers>>`
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

        // Delay required for GitHub actions
        await new Promise((resolve) => setTimeout(resolve, 500));

        return redirect(redirectTo || "/");
      } catch (e) {
        if (e instanceof pg.DatabaseError) {
          if (e.code === "23505") {
            throw new Error("Username already exists", { cause: e });
          }
        }
        console.error(e);
        throw new Error("Registration failed", { cause: e });
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

      try {
        const {
          rows: [user],
        } = await sql<Selectable<AppPublicUsers>>`
          select u.* from app_private.login(${id}::citext, ${password}) u
          where not (u is null)
        `.execute(rootDb);

        if (!user?.id) {
          throw new Error("Invalid credentials");
        }

        const { token, expiresAt } = await createSession(user.id);
        cookie[sessionCookieName]?.set(buildSessionCookie(token, expiresAt));

        // Delay required for GitHub actions
        await new Promise((resolve) => setTimeout(resolve, 500));

        return redirect(redirectTo || "/");
      } catch (e) {
        console.error(e);
        throw new Error("Login failed", { cause: e });
      }
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
        verified: query.verified === "true" ? true : false,
        name: query.name,
        avatarUrl: query.avatarUrl,
        password: query.password,
      });

      let verificationToken: string | null = null;
      const userEmailSecrets = await getUserEmailSecrets(
        query.email ?? `${query.username ?? "testuser"}@example.com`,
      );
      const userEmailId: string = userEmailSecrets.user_email_id;
      if (!query.verified) {
        verificationToken = userEmailSecrets.verification_token;
      }

      return { user, userEmailId, verificationToken };
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
        email: t.Optional(t.String()),
        verified: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        name: t.Optional(t.String()),
        avatarUrl: t.Optional(t.String()),
        password: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/getUserEmailSecrets",
    async ({ query }) => {
      const { email = "testuser@example.com" } = query;
      const userSecrets = await getUserEmailSecrets(email);
      return userSecrets;
    },
    {
      query: t.Object({
        email: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/getUserSecrets",
    async ({ query }) => {
      const { username = "testuser" } = query;
      const userSecrets = await getUserSecrets(username);
      return userSecrets;
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/verifyUser",
    async ({ query }) => {
      const { username = "testuser" } = query;
      await rootDb
        .updateTable("app_public.users")
        .set({ is_verified: true })
        .where("username", "=", username)
        .execute();
      return { success: true };
    },
    {
      query: t.Object({
        username: t.Optional(t.String()),
      }),
    },
  );

export const testingApi = edenFetch<typeof testingServer>(
  `http://localhost:${env.PORT}/api/testingCommand`,
);

async function reallyCreateUser({
  username,
  email,
  verified = false,
  name,
  avatarUrl = null,
  password = "TestUserPassword",
  orgs = [],
}: {
  username?: string;
  email?: string;
  verified?: boolean;
  name?: string;
  avatarUrl?: string | null;
  password?: string;
  orgs?: [string, string, boolean?][];
}) {
  // Generate unique username if not provided to avoid conflicts
  // Constraint: 2-64 chars, must start with letter, can contain letters/numbers/underscore/hyphen
  // Using "test_" prefix for cleanup pattern matching
  const timestamp = Date.now().toString(36); // Base36 is shorter (~11 chars)
  const random = Math.random().toString(36).substring(2, 6); // 4 chars for better uniqueness
  const finalUsername = username ?? `test_${timestamp}${random}`;
  const finalEmail = email ?? `${finalUsername}@example.com`;
  const finalName = name ?? finalUsername;

  const user = await rootDb
    .selectFrom(
      sql<Selectable<AppPublicUsers>>`app_private.really_create_user(
        username => ${finalUsername}::citext,
        email => ${finalEmail},
        email_is_verified => ${verified ?? false},
        name => ${finalName},
        avatar_url => ${avatarUrl ?? null},
        password => ${password}::text
      )`.as("u"),
    )
    .selectAll()
    .executeTakeFirstOrThrow();

  const sessionData = await createSession(user.id);

  // Only create testuser_other and orgs if orgs array is provided
  if (orgs && orgs.length > 0) {
    const otherUser = await rootDb
      .selectFrom(
        sql<Selectable<AppPublicUsers>>`app_private.really_create_user(
          username => 'testuser_other'::citext,
          email => 'testuser_other@example.com',
          email_is_verified => true,
          name => 'testuser_other',
          avatar_url => null,
          password => 'DOESNT MATTER'::text
        )`.as("u"),
      )
      .selectAll()
      .executeTakeFirstOrThrow();

    const otherSession = await createSession(otherUser.id);

    await rootDb.transaction().execute(async (trx) => {
      async function setSession(sess: typeof sessionData) {
        await sql`
          select
            set_config('role', ${env.DATABASE_VISITOR}, false),
            set_config('my.session_id', ${sess.id}, true)
        `.execute(trx);
      }

      await setSession(sessionData);
      await Promise.all(
        orgs.map(
          async ([name, slug, owner = true]: [string, string, boolean?]) => {
            if (!owner) await setSession(otherSession);

            const {
              rows: [organization],
            } =
              await sql<AppPublicOrganizations>`select * from app_public.create_organization(${slug}, ${name})`.execute(
                trx,
              );

            if (!owner && organization) {
              await sql`select app_public.invite_to_organization(${organization.id}::uuid, ${user.username}::citext, null::citext)`.execute(
                trx,
              );
              await setSession(sessionData);
              await sql`select app_public.accept_invitation_to_organization(organization_invitations.id) from app_public.organization_invitations where user_id = ${user.id}`.execute(
                trx,
              );
            }
          },
        ),
      );
    });
  }

  return { user, session: sessionData };
}

async function getUserSecrets(username: string) {
  // join user_secrets with users to fetch combined row
  const result = await rootDb
    .selectFrom("app_private.user_secrets as us")
    .innerJoin("app_public.users as u", "us.user_id", "u.id")
    .selectAll("us")
    .select(["u.id as user_id", "u.username"])
    .where("u.username", "=", username)
    .executeTakeFirst();
  return result;
}

async function getUserEmailSecrets(email: string) {
  const result = await rootDb
    .selectFrom("app_private.user_email_secrets")
    .selectAll()
    .where((eb) =>
      eb(
        "user_email_id",
        "=",
        eb
          .selectFrom("app_public.user_emails")
          .where("email", "=", email)
          .select("id")
          .orderBy("id", "desc")
          .limit(1),
      ),
    )
    .executeTakeFirstOrThrow();
  return result;
}
