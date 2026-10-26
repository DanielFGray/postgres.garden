/**
 * Test-only HTTP routes under `/api/testing`. The e2e suite and `auth.test.ts`
 * call them to create users and sessions and to read secrets, without going
 * through the public API.
 *
 * `index.ts` serves these routes outside production only. A failed route
 * answers 500 with a fixed body, so internal error text never reaches a test.
 */
import { Effect, Layer, Random, Schema as S } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { sql, type ExpressionBuilder } from "kysely";
import { valkey } from "./valkey.js";
import { env } from "./assertEnv.js";
import type { DB, AppPublicUsers as User } from "../generated/db.js";
import { SessionService, sessionKey } from "./services/sessionService.js";
import { makeSetCookie } from "./services/cookies.js";
import { DatabaseLive, rootQuerier, runQuery } from "./db.js";

const publicUrl = env.VITE_ROOT_URL.replace(/\/$/, "");

const resolveRedirectLocation = (target: string) =>
  target.startsWith("http") ? target : new URL(target, `${publicUrl}/`).toString();

export class ValkeyError extends S.TaggedError<ValkeyError>()("ValkeyError", {
  cause: S.Unknown,
}) {}

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
 * Creates a user through `really_create_user`, then opens a session for it.
 * Omitted fields get test defaults; an omitted username is generated.
 */
const reallyCreateUser = Effect.fnUntraced(function* (input: {
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly verified: boolean;
  readonly password?: string | undefined;
}) {
  const runRoot = yield* rootQuerier;
  const sessions = yield* SessionService;
  const randomValue = input.username == null ? yield* Random.next : 0;
  const username = input.username ?? `testuser_${randomValue.toString(36).slice(2, 10)}`;
  const email = input.email ?? `${username}@example.com`;

  const user = yield* runRoot((db) =>
    runQuery(
      db
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
    ).pipe(Effect.head),
  );

  const session = yield* sessions.createSession(user.id);
  return { user, session };
});

const getUserSecrets = Effect.fnUntraced(function* (username: string) {
  const runRoot = yield* rootQuerier;
  return yield* runRoot((db) =>
    runQuery(
      db
        .selectFrom("app_private.user_secrets")
        .selectAll()
        .where("user_id", "=", (eb: ExpressionBuilder<DB, "app_private.user_secrets">) =>
          eb.selectFrom("app_public.users").select("id").where("username", "=", username),
        ),
    ).pipe(Effect.head),
  );
});

const getUserEmailSecrets = Effect.fnUntraced(function* (email: string) {
  const runRoot = yield* rootQuerier;
  return yield* runRoot((db) =>
    runQuery(
      db
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
    ).pipe(Effect.head),
  );
});

const sessionRedirect = (token: string, expiresAt: Date, redirectTo: string | undefined) =>
  HttpServerResponse.redirect(resolveRedirectLocation(redirectTo ?? "/"), {
    headers: { "set-cookie": makeSetCookie(token, expiresAt) },
  });

const clearTestUsers = Effect.gen(function* () {
  const runRoot = yield* rootQuerier;
  yield* runRoot((db) =>
    runQuery(db.deleteFrom("app_public.users").where("username", "like", "test%")),
  );
  const keys = yield* Effect.tryPromise({
    try: () => valkey.keys(sessionKey("*")),
    catch: (cause) => new ValkeyError({ cause }),
  });
  if (keys.length > 0) {
    yield* Effect.tryPromise({
      try: () => valkey.del(...keys),
      catch: (cause) => new ValkeyError({ cause }),
    });
  }
  return HttpServerResponse.jsonUnsafe({ success: true });
});

const login = Effect.gen(function* () {
  const query = yield* HttpServerRequest.schemaSearchParams(LoginQuery);
  const { session } = yield* reallyCreateUser({
    username: query.username,
    email: query.email,
    verified: query.verified === "true",
    password: query.password,
  });
  return sessionRedirect(session.token, session.expiresAt, query.redirectTo);
});

const register = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(RegisterBody);
  const { session } = yield* reallyCreateUser({
    username: body.username,
    email: body.email,
    verified: false,
    password: body.password,
  });
  return sessionRedirect(session.token, session.expiresAt, body.redirectTo);
});

const loginPost = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(LoginPostBody);
  const runRoot = yield* rootQuerier;
  const sessions = yield* SessionService;
  const user = yield* runRoot((db) =>
    runQuery(
      db
        .selectFrom((eb) =>
          eb
            .fn<User>("app_private.login", [sql`${body.id}::citext`, eb.val(body.password)])
            .as("u"),
        )
        .selectAll()
        // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
        .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
    ).pipe(Effect.head),
  );
  const session = yield* sessions.createSession(user.id);
  return sessionRedirect(session.token, session.expiresAt, body.redirectTo);
});

const createUser = Effect.gen(function* () {
  const query = yield* HttpServerRequest.schemaSearchParams(UserQuery);
  const { user } = yield* reallyCreateUser({
    username: query.username,
    email: query.email,
    verified: query.verified === "true",
    password: query.password,
  });
  const email = query.email ?? `${query.username ?? "testuser"}@example.com`;
  const secrets = yield* getUserEmailSecrets(email);
  return HttpServerResponse.jsonUnsafe({
    user,
    userEmailId: secrets.user_email_id,
    verificationToken: query.verified === undefined ? secrets.verification_token : null,
  });
});

const userSecrets = Effect.gen(function* () {
  const query = yield* HttpServerRequest.schemaSearchParams(UsernameQuery);
  return HttpServerResponse.jsonUnsafe(yield* getUserSecrets(query.username ?? "testuser"));
});

const emailSecrets = Effect.gen(function* () {
  const query = yield* HttpServerRequest.schemaSearchParams(EmailQuery);
  return HttpServerResponse.jsonUnsafe(yield* getUserEmailSecrets(query.email));
});

const verifyUser = Effect.gen(function* () {
  const query = yield* HttpServerRequest.schemaSearchParams(UsernameQuery);
  const runRoot = yield* rootQuerier;
  yield* runRoot((db) =>
    runQuery(
      db
        .updateTable("app_public.users")
        .set({ is_verified: true })
        .where("username", "=", query.username ?? "testuser"),
    ),
  );
  return HttpServerResponse.jsonUnsafe({ success: true });
});

/**
 * Maps a failed route to a response. Schema failures answer 422; anything
 * else is logged and answers 500 with a fixed body.
 */
const testingRoute = <E, R>(
  method: "GET" | "POST",
  path: `/${string}`,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.route(
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

const TestingRoutes = HttpRouter.addAll([
  testingRoute("GET", "/clearTestUsers", clearTestUsers),
  testingRoute("GET", "/login", login),
  testingRoute("POST", "/register", register),
  testingRoute("POST", "/loginPost", loginPost),
  testingRoute("GET", "/createUser", createUser),
  testingRoute("GET", "/getUserSecrets", userSecrets),
  testingRoute("GET", "/getEmailSecrets", emailSecrets),
  testingRoute("GET", "/verifyUser", verifyUser),
]);

/** Refuses to build the routes in production, even when a caller imports this module there. */
const ProductionGuard = Layer.effectDiscard(
  env.NODE_ENV === "production"
    ? Effect.die("testing routes must not run in production")
    : Effect.void,
);

export const TestingRoutesLive = TestingRoutes.pipe(
  HttpRouter.provideRequest(
    Layer.mergeAll(SessionService.layer.pipe(Layer.provideMerge(DatabaseLive)), ProductionGuard),
  ),
);
