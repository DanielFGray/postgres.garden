/**
 * Test-only HTTP routes under `/api/testing`. The e2e suite and `auth.test.ts`
 * call them to create users and sessions and to read secrets, without going
 * through the public API.
 *
 * `ApiRoutesLive` (runtime.ts) mounts these routes outside production only. A failed route
 * answers 500 with a fixed body, so internal error text never reaches a test.
 */
import { Context, Effect, Layer, Random, Schema as S } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { sql, type ExpressionBuilder } from "kysely";
import { Redis } from "effect/persistence/Redis";
import { isProduction, rootUrl } from "./config.js";
import type { DB, AppPublicUsers as User } from "../generated/db.js";
import { SessionService, sessionKeyOf } from "./services/sessionService.js";
import { rateLimitKeyPrefix } from "./services/rateLimiter.js";
import { Cookies } from "./services/cookies.js";
import { PgRootDB } from "./db.js";

const UserQuery = S.Struct({
  username: S.optional(S.String),
  email: S.optional(S.String),
  verified: S.optional(S.Literals(["true", "false"])),
  password: S.optional(S.String),
});

const LoginQuery = S.Struct({ ...UserQuery.fields, redirectTo: S.optional(S.String) });

const EmailQuery = S.Struct({ email: S.String });

const UsernameQuery = S.Struct({ username: S.optional(S.String) });

const RegisterBody = S.Struct({
  username: S.String,
  password: S.String.check(S.isMinLength(8)),
  email: S.String.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  redirectTo: S.optional(S.String),
});

const LoginPostBody = S.Struct({
  id: S.String,
  password: S.String,
  redirectTo: S.optional(S.String),
});

/**
 * Creates, signs in and inspects test accounts directly in Postgres and
 * Valkey. Building it fails in production, so the routes cannot exist there
 * even when a caller imports this module.
 */
class TestingService extends Context.Service<TestingService>()("TestingService", {
  make: Effect.gen(function* () {
    if (yield* isProduction) {
      return yield* Effect.die("testing routes must not run in production");
    }
    const root = yield* PgRootDB;
    const sessions = yield* SessionService;
    const cookies = yield* Cookies;
    const redis = yield* Redis;
    const sessionKey = yield* sessionKeyOf;
    const rateLimitPrefix = yield* rateLimitKeyPrefix();
    const siteUrl = yield* rootUrl;

    /**
     * Creates a user through `really_create_user`, then opens a session for it.
     * Omitted fields get test defaults; an omitted username is generated.
     */
    const reallyCreateUser = Effect.fnUntraced(function* (input: {
      readonly username?: string | undefined;
      readonly email?: string | undefined;
      readonly verified: boolean;
      readonly password?: string | undefined;
    }) {
      const randomValue = input.username == null ? yield* Random.next : 0;
      const username = input.username ?? `testuser_${randomValue.toString(36).slice(2, 10)}`;
      const email = input.email ?? `${username}@example.com`;

      const user = yield* root
        .all(
          root.connection
            .selectFrom(
              sql<User>`app_private.really_create_user(
                username => ${username}::citext,
                email => ${email}::citext,
                email_is_verified => ${input.verified},
                password => ${input.password ?? "TestUserPassword"}::text
              )`.as("u"),
            )
            .selectAll()
            // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
            .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
        )
        .pipe(Effect.head);

      const session = yield* sessions.createSession(user.id);
      return { user, session };
    });

    const userSecrets = (username: string) =>
      root
        .all(
          root.connection
            .selectFrom("app_private.user_secrets")
            .selectAll()
            .where("user_id", "=", (eb: ExpressionBuilder<DB, "app_private.user_secrets">) =>
              eb.selectFrom("app_public.users").select("id").where("username", "=", username),
            ),
        )
        .pipe(Effect.head);

    const emailSecrets = (email: string) =>
      root
        .all(
          root.connection
            .selectFrom("app_private.user_email_secrets")
            .selectAll()
            .where(
              "user_email_id",
              "=",
              (eb: ExpressionBuilder<DB, "app_private.user_email_secrets">) =>
                eb
                  .selectFrom("app_public.user_emails")
                  .select("id")
                  .where("email", "=", email)
                  .orderBy("id", "desc")
                  .limit(1),
            ),
        )
        .pipe(Effect.head);

    const sessionRedirect = (
      session: { readonly token: string; readonly expiresAt: Date },
      redirectTo: string | undefined,
    ) => {
      const target = redirectTo ?? "/";
      const location = target.startsWith("http")
        ? target
        : new URL(target, `${siteUrl}/`).toString();
      return HttpServerResponse.redirect(location, {
        headers: { "set-cookie": cookies.sessionHeader(session.token, session.expiresAt) },
      });
    };

    const deleteKeys = (pattern: string) =>
      redis.send("KEYS", pattern).pipe(
        Effect.flatMap(S.decodeUnknownEffect(S.Array(S.String))),
        Effect.flatMap((keys) => (keys.length > 0 ? redis.send("DEL", ...keys) : Effect.void)),
      );

    const success = HttpServerResponse.jsonUnsafe({ success: true });

    return {
      clearTestUsers: root
        .all(root.connection.deleteFrom("app_public.users").where("username", "like", "test%"))
        .pipe(Effect.andThen(deleteKeys(sessionKey("*"))), Effect.as(success)),

      /**
       * Deletes every rate-limit count. The e2e suite runs from one address, so
       * the counts that earlier runs leave in Valkey would refuse a later run.
       */
      clearRateLimits: deleteKeys(`${rateLimitPrefix}*`).pipe(Effect.as(success)),

      login: (query: typeof LoginQuery.Type) =>
        reallyCreateUser({
          username: query.username,
          email: query.email,
          verified: query.verified === "true",
          password: query.password,
        }).pipe(Effect.map(({ session }) => sessionRedirect(session, query.redirectTo))),

      register: (body: typeof RegisterBody.Type) =>
        reallyCreateUser({
          username: body.username,
          email: body.email,
          verified: false,
          password: body.password,
        }).pipe(Effect.map(({ session }) => sessionRedirect(session, body.redirectTo))),

      loginPost: Effect.fn("TestingService.loginPost")(function* (body: typeof LoginPostBody.Type) {
        const user = yield* root
          .all(
            root.connection
              .selectFrom((eb) =>
                eb
                  .fn<User>("app_private.login", [sql`${body.id}::citext`, eb.val(body.password)])
                  .as("u"),
              )
              .selectAll()
              // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
          )
          .pipe(Effect.head);
        const session = yield* sessions.createSession(user.id);
        return sessionRedirect(session, body.redirectTo);
      }),

      createUser: Effect.fn("TestingService.createUser")(function* (query: typeof UserQuery.Type) {
        const { user } = yield* reallyCreateUser({
          username: query.username,
          email: query.email,
          verified: query.verified === "true",
          password: query.password,
        });
        const email = query.email ?? `${query.username ?? "testuser"}@example.com`;
        const secrets = yield* emailSecrets(email);
        return HttpServerResponse.jsonUnsafe({
          user,
          userEmailId: secrets.user_email_id,
          verificationToken: query.verified === undefined ? secrets.verification_token : null,
        });
      }),

      userSecrets: (username: string) =>
        userSecrets(username).pipe(Effect.map((row) => HttpServerResponse.jsonUnsafe(row))),

      emailSecrets: (email: string) =>
        emailSecrets(email).pipe(Effect.map((row) => HttpServerResponse.jsonUnsafe(row))),

      verifyUser: (username: string) =>
        root
          .all(
            root.connection
              .updateTable("app_public.users")
              .set({ is_verified: true })
              .where("username", "=", username),
          )
          .pipe(Effect.as(success)),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(SessionService.layer, Cookies.layer)),
  );
}

export const TestingRoutesLive = HttpRouter.addAll(
  Effect.gen(function* () {
    const testing = yield* TestingService;
    const searchParams = HttpServerRequest.schemaSearchParams;
    const body = HttpServerRequest.schemaBodyJson;
    return [
      testingRoute("GET", "/clearTestUsers", testing.clearTestUsers),
      testingRoute("GET", "/clearRateLimits", testing.clearRateLimits),
      testingRoute("GET", "/login", Effect.flatMap(searchParams(LoginQuery), testing.login)),
      testingRoute("POST", "/register", Effect.flatMap(body(RegisterBody), testing.register)),
      testingRoute("POST", "/loginPost", Effect.flatMap(body(LoginPostBody), testing.loginPost)),
      testingRoute(
        "GET",
        "/createUser",
        Effect.flatMap(searchParams(UserQuery), testing.createUser),
      ),
      testingRoute(
        "GET",
        "/getUserSecrets",
        Effect.flatMap(searchParams(UsernameQuery), ({ username }) =>
          testing.userSecrets(username ?? "testuser"),
        ),
      ),
      testingRoute(
        "GET",
        "/getEmailSecrets",
        Effect.flatMap(searchParams(EmailQuery), ({ email }) => testing.emailSecrets(email)),
      ),
      testingRoute(
        "GET",
        "/verifyUser",
        Effect.flatMap(searchParams(UsernameQuery), ({ username }) =>
          testing.verifyUser(username ?? "testuser"),
        ),
      ),
    ];
  }),
).pipe(Layer.provide(TestingService.layer));

/**
 * Maps a failed route to a response. Schema failures answer 422; anything
 * else is logged and answers 500 with a fixed body.
 */
function testingRoute<E, R>(
  method: "GET" | "POST",
  path: `/${string}`,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return HttpRouter.route(
    method,
    `/api/testing${path}`,
    handler.pipe(
      Effect.catch((error) =>
        S.isSchemaError(error)
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe({ error: "Invalid request" }, { status: 422 }),
            )
          : Effect.logError(error).pipe(
              Effect.as(
                HttpServerResponse.jsonUnsafe({ error: "Internal Server Error" }, { status: 500 }),
              ),
            ),
      ),
    ),
  );
}
