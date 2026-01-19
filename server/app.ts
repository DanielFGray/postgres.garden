import { Webhooks } from "@octokit/webhooks";
import { Elysia, t } from "elysia";
import { Logestic } from "logestic";
import Postgres from "postgres";
import { Lucia } from "lucia";
import { templateHack as gql, randomNumber, sleep } from "~lib/index";
import {
  GitHub,
  OAuth2RequestError,
  generateCodeVerifier,
  generateState,
  OAuth2Provider,
} from "arctic";
import { PostgresJsAdapter } from "@lucia-auth/adapter-postgresql";
import { ElysiaCookie } from "node_modules/elysia/dist/cookies";
import "./assertEnv";
import { getWorker } from "./worker";
import type { Nullable } from "~/types.d";

type User = {
  id: string;
  username: string;
  name: string | null;
  avatar_url: string | null;
  bio: string | null;
  role: "user" | "sponsor" | "pro" | "admin";
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
};

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_PAT,
  NODE_ENV,
  DATABASE_URL,
  AUTH_DATABASE_URL,
  DATABASE_VISITOR,
} = process.env;

const isProd = NODE_ENV === "production";

const sqlConfig = {
  transform: {
    undefined: null,
    // ...Postgres.camel,
  },
  onnotice(thing: Postgres.Notice) {
    console.info(thing.message);
  },
};

const sql = Postgres(DATABASE_URL, sqlConfig);
const authSql = Postgres(AUTH_DATABASE_URL, sqlConfig);

async function withAuthContext<R>(
  sessionId: string | undefined,
  cb: (sql: Postgres.TransactionSql) => R,
) {
  return await authSql.begin(async sql => {
    await sql`
      select
        set_config('role', ${DATABASE_VISITOR}, false),
        set_config('my.session_id', ${sessionId ?? null}, true);`;
    return cb(sql);
  });
}

type UserInfo = Pick<User, "id" | "username" | "role" | "is_verified">;

export const lucia = new Lucia(
  new PostgresJsAdapter(sql, {
    user: "app_public.users",
    session: "app_private.sessions",
  }),
  {
    sessionCookie: {
      attributes: {
        sameSite: "strict",
        secure: isProd,
      },
    },
    getUserAttributes(a) {
      return {
        id: a.id,
        username: a.username,
        role: a.role,
        is_verified: a.is_verified,
      } satisfies UserInfo;
    },
  },
);

declare module "lucia" {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: User;
  }
}

const oauthProviders: { github?: OAuth2Provider } = {};
if (GITHUB_PAT && GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET) {
  oauthProviders.github = new GitHub(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET);
} else {
  console.error(
    "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for oauth login",
  );
}

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

export const app = new Elysia({
  cookie: { secrets: process.env.SECRET },
})
  .use(Logestic.preset(isProd ? "common" : "fancy"))
  .derive(async ({ cookie }) => {
    const { user, session } = await lucia.validateSession(
      cookie[lucia.sessionCookieName].value,
    );
    return { user, session };
  })
  .post(
    "/register",
    async ({ body, cookie, error, user: currentUser }) => {
      if (currentUser) return error(403, "already authenticated");
      const { username, email, password } = body;
      try {
        const [user] = await sql<Nullable<User>[]>`
          select u.* from app_private.really_create_user(
            username => ${username}::citext,
            email => ${email}::citext,
            email_is_verified => false,
            password => ${password}::text
          ) u
          where not (u is null);
        `;
        if (!user.id) return error(500, "Registration failed");
        const session = await lucia.createSession(user.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);
        cookie[sessionCookie.name]?.set(sessionCookie);

        return user;
      } catch (e) {
        if (e instanceof Postgres.PostgresError) {
          if (e.code === "23505") return error(409, "username already exists");
        }
        console.error(e);
        return error(500, "Registration failed");
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String({ minLength: 8 }),
        email: t.String({ format: "email" }),
      }),
    },
  )

  .post(
    "/login",
    async ({ body, cookie, error, user: currentUser }) => {
      if (currentUser) return error(403, "already authenticated");
      const { id, password } = body;

      try {
        const [user] = await sql<Nullable<User>[]>`
          select u.* from app_private.login(${id}::citext, ${password}) u
          where not (u is null)
        `;
        if (!user?.id) {
          await randomDelay();
          return error(401, "invalid id or password");
        }

        const session = await lucia.createSession(user.id, {});
        const sessionCookie = lucia.createSessionCookie(session.id);

        cookie[sessionCookie.name]?.set(sessionCookie);

        return user;
      } catch (e) {
        console.error(e);
        return error(500, "Login failed");
      }
    },
    {
      body: t.Object({
        id: t.String(),
        password: t.String(),
      }),
    },
  )

  .get(
    "/auth/:provider",
    async ({ params, cookie, set, query }) => {
      const state = generateState();
      const codeVerifier = generateCodeVerifier();

      const redirectUrl =
        await oauthProviders[params.provider].createAuthorizationURL(state);

      const cookieOpts: ElysiaCookie = {
        path: "/",
        secure: isProd,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 10,
      };
      cookie.oauth_state?.set({ ...cookieOpts, value: state });
      cookie.oauth_code_verifier?.set({ ...cookieOpts, value: codeVerifier });
      cookie.oauth_next?.set({ ...cookieOpts, value: query.redirectTo ?? "/" });

      set.redirect = redirectUrl.toString();
    },
    {
      query: t.Object({ redirectTo: t.Optional(t.String()) }),
      params: t.Object({
        provider: t.Union(Object.keys(oauthProviders).map(p => t.Literal(p))),
      }),
    },
  )

  .get(
    "/auth/:provider/callback",
    async ({
      params,
      query: { code, state },
      cookie,
      set,
      error,
      user: currentUser,
    }) => {
      const { oauth_state, oauth_code_verifier, oauth_next } = cookie;
      const next = oauth_next?.value ?? "/";
      const storedState = oauth_state?.value;
      const storedCodeVerifier = oauth_code_verifier?.value;
      const provider = oauthProviders[params.provider as "github"]!;

      if (!storedState || !storedCodeVerifier || state !== storedState) {
        return error(
          400,
          "The state provided does not match the state in the cookie.",
        );
      }

      let linkUser;

      try {
        const tokens = await provider.validateAuthorizationCode(code);
        switch (params.provider) {
          case "github": {
            const userInformation = await (
              await fetch("https://api.github.com/user", {
                headers: {
                  Authorization: `Bearer ${tokens.accessToken}`,
                },
              })
            ).json();
            console.log(JSON.stringify(userInformation, null, 2));
            [linkUser] = await sql<Nullable<User>[]>`
              select * from app_private.link_or_register_user(
                f_user_id => ${currentUser?.id ?? null}::uuid,
                f_service => ${params.provider as string},
                f_identifier => ${userInformation.id}::text,
                f_profile => ${sql.json(userInformation) as unknown as string}::json,
                f_auth_details => ${sql.json(tokens as any) as unknown as string}::json
              );`;
            if (!(linkUser && linkUser.id)) {
              return error(500, "Registration failed");
            }

            const { data: sponsorInfo } = await (
              await fetch("https://api.github.com/graphql", {
                headers: {
                  Authorization: `Bearer ${process.env.GITHUB_PAT}`,
                },
                method: "POST",
                body: JSON.stringify({
                  query: getGithubSponsorInfo,
                  variables: {
                    user: userInformation.login,
                    owner: "danielfgray",
                    repo: "postgres.garden",
                  },
                }),
              })
            ).json();

            switch (true) {
              case sponsorInfo.user.isViewer:
                await sql`update app_public.users set role = 'admin' where id = ${linkUser.id}::uuid;`;
                console.log("github user %s is admin", userInformation.login);
                break;
              case sponsorInfo.user.isSponsoringViewer:
                await sql`update app_public.users set role = 'sponsor' where id = ${linkUser.id}::uuid;`;
                console.log("github user %s is sponsor", userInformation.login);
                break;
              case sponsorInfo.repository.collaborators.totalCount > 0:
                await sql`update app_public.users set role = 'sponsor' where id = ${linkUser.id}::uuid;`;
                console.log(
                  "github user %s is collaborator",
                  userInformation.login,
                );
                break;
            }
          }
        }

        if (linkUser?.id && !currentUser) {
          const session = await lucia.createSession(linkUser.id, {});
          const sessionCookie = lucia.createSessionCookie(session.id);

          cookie[sessionCookie.name]?.set(sessionCookie);
        }
        set.redirect = next;
      } catch (e) {
        if (
          e instanceof OAuth2RequestError &&
          e.message === "bad_verification_code"
        ) {
          // invalid code
          return error(400, "Registration failed");
        }
        console.error(e);
        return error(500, "Registration failed");
      }
    },
    {
      query: t.Object(
        {
          code: t.String(),
          state: t.String(),
        },
        { additionalProperties: true },
      ),
      params: t.Object({
        provider: t.Union(Object.keys(oauthProviders).map(p => t.Literal(p))),
      }),
    },
  )

  .post("/logout", async ({ error }) => {
    try {
      await sql<{ logout: unknown | null }[]>`select app_public.logout();`;
    } catch (e) {
      console.error(e);
      error(500, "Logout failed");
    }
  })

  .get("/me", ({ user }) => user)

  .delete(
    "/me",
    async ({ query, user: currentUser, error }) => {
      if (!currentUser) return error(401);

      try {
        if (!query.token) {
          return await sql<
            { request_account_deletion: unknown | null }[]
          >`select app_public.request_account_deletion();`;
        }
        const [result] = await sql<
          { confirm_account_deletion: boolean | null }[]
        >`select * from app_public.confirm_account_deletion(${query.token});`;
        return result;
      } catch (e) {
        console.error(e);
        error(500, "Account deletion failed");
      }
    },
    { query: t.Object({ token: t.Optional(t.String()) }) },
  )

  .post(
    "/forgotPassword",
    async ({ body, error }) => {
      try {
        const [result] = await sql<
          { forgot_password: unknown | null }[]
        >`select app_public.forgot_password(${body.email}::citext);`;
        return result;
      } catch (e) {
        console.error(e);
        error(500, "Failed to send password reset email");
      }
    },
    { body: t.Object({ email: t.String() }) },
  )

  .post(
    "/resetPassword",
    async ({ body, error }) => {
      try {
        const [result] = await sql<
          { reset_password: boolean | null }[]
        >`select * from app_private.reset_password(
          ${body.userId}::uuid,
          ${body.token}::text,
          ${body.password}::text
        );`;
        return result;
      } catch (e) {
        console.error(e);
        error(500, "Failed to reset password");
      }
    },
    {
      body: t.Object({
        userId: t.String({ format: "uuid" }),
        token: t.String(),
        password: t.String(),
      }),
    },
  )

  .post(
    "/changePassword",
    async ({ body }) => {
      const [result] = await sql<
        { change_password: boolean | null }[]
      >`select * from app_public.change_password(${body.oldPassword}, ${body.newPassword});`;
      return result;
    },
    { body: t.Object({ oldPassword: t.String(), newPassword: t.String() }) },
  )

  .post(
    "/verifyEmail",
    async ({ body }) => {
      const [result] = await sql<
        { verify_email: boolean | null }[]
      >`select * from app_public.verify_email(${body.emailId}::uuid, ${body.token});`;
      return result;
    },
    {
      body: t.Object({
        emailId: t.String({ format: "uuid" }),
        token: t.String(),
      }),
    },
  )

  .post(
    "/makeEmailPrimary",
    async ({ body }) => {
      return await sql<
        {
          id: string | null;
          user_id: string | null;
          email: string | null;
          is_verified: boolean | null;
          is_primary: boolean | null;
          created_at: Date | null;
          updated_at: Date | null;
        }[]
      >`select * from app_public.make_email_primary(${body.emailId}::uuid) where not (id is null);`;
    },
    { body: t.Object({ emailId: t.String({ format: "uuid" }) }) },
  )

  .post(
    "/resendEmailVerificationCode",
    async ({ body }) => {
      return await sql<
        { resend_email_verification_code: boolean | null }[]
      >`select * from app_public.resend_email_verification_code(${body.emailId}::uuid);`;
    },
    { body: t.Object({ emailId: t.String({ format: "uuid" }) }) },
  )

  .post(
    "/playgrounds",
    async ({ body, user, session, error }) => {
      if (!user) return error(401, "You need to login to post");

      return await withAuthContext(session.id, async sql => {
        try {
          const data = { defaultLayout: body.defaultLayout, files: body.files };
          const [{ id }] = await sql<{ id: number }[]>`
            insert into app_public.playgrounds
              (fork_id, privacy, name, description, data)
            values (
              ${body.fork_id ?? null},
              ${body.privacy ?? "public"},
              ${body.name ?? null},
              ${body.description ?? null},
              ${sql.json(Object.assign({ version: 1 }, data))}
            )
            returning id;
          `;
          return id;
        } catch (e) {
          if (e instanceof Postgres.PostgresError) {
            console.error(e.detail);
            console.error(e);
          }
          return error(500, "failed to create new playground");
        }
      });
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        fork_id: t.Optional(t.Number()),
        privacy: t.Optional(
          t.Union([t.Literal("private"), t.Literal("public")]),
        ),
        defaultLayout: t.Optional(
          t.Partial(
            t.Object({
              editors: t.Array(
                t.Object({
                  uri: t.String(),
                  viewColumn: t.Number(),
                }),
              ),
              layout: t.Object({
                editors: t.Object({
                  orientation: t.Number(),
                  groups: t.Array(
                    t.Object({
                      size: t.Number(),
                    }),
                  ),
                }),
              }),
            }),
          ),
        ),
        // files: t.Files(),
        files: t.Record(t.String(), t.String()),
      }),
    },
  )

  .get(
    "/user/:username",
    async ({ session, params }) => {
      return await withAuthContext(session?.id, async sql => {
        const playgrounds = await sql<
          {
            id: number;
            fork_id: number | null;
            name: string | null;
            description: string | null;
            stars: string | null;
            created_at: Date;
          }[]
        >`
          select
            p.id,
            p.fork_id,
            p.name,
            p.description,
            stars,
            p.created_at
          from
            app_public.playgrounds p
            join app_public.users u
              on p.user_id = u.id,
            lateral (
              select count(*) as stars
              from app_public.playground_stars
            ) as get_stars
          where
            username = ${params.username}
          order by created_at desc
          fetch first 50 rows only;
        `;
        // postgres.js returns a RowList object that needs to be converted to
        // an array or elysia fails to serialize
        return [...playgrounds];
      });
    },
    {
      params: t.Object({
        username: t.String(),
      }),
    },
  )

  .get(
    "/playground/:id",
    async ({ params, session, error }) => {
      const data = await withAuthContext(session?.id, async sql => {
        const [playground] = await sql<
          {
            id: number;
            name: string | null;
            privacy: "private" | "secret" | "public";
            created_at: Date;
            updated_at: Date;
            description: string | null;
            user: { username: string };
            fork_id: number | null;
            data: any;
          }[]
        >`
          select
            p.id,
            p.name,
            p.privacy,
            p.created_at,
            p.updated_at,
            p.description,
            json_build_object(
              'username', u.username
            ) as user,
            fork_id,
            p.data
          from
            app_public.playgrounds p
            join app_public.users u
              on p.user_id = u.id
          where p.id = ${params.id}::int;
        `;
        return playground;
      });
      if (!data) return error(404, "playground not found");
      // if (headers["accept"] === "application/json") return data;
      return data;
    },
    { params: t.Object({ id: t.Number() }) },
  )

  .post(
    "/webhooks/gh_sponsor",
    async ({ headers, body, error }) => {
      const signature = headers["x-hub-signature-256"];
      const valid = await webhooks.verify(JSON.stringify(body), signature);
      if (!valid)
        return error(400, { type: "Error", message: "Invalid signature" });
      getWorker().addJob("processWebhook", body);
      return { ok: true };
    },
    {
      body: t.Unknown(),
      headers: t.Object({
        secret: t.Optional(t.String()),
        "x-hub-signature-256": t.String(),
      }),
    },
  );

const webhooks = new Webhooks({ secret: process.env.SECRET });

export type App = typeof app;

async function randomDelay(min = 100, max = 600) {
  await sleep(randomNumber(min, max));
}
