/**
 * Test-only HTTP routes under `/api/testing`. The e2e suite and `auth.test.ts`
 * call them to create users and sessions and to read the mail the server
 * sent, without going through the public API.
 *
 * `ApiRoutesLive` (runtime.ts) mounts these routes outside production only. A failed route
 * answers 500 with a fixed body, so internal error text never reaches a test.
 */
import { Array as Arr, Context, Effect, Layer, Random, Schema as S } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { InternalError } from "@danielfgray/stompbox/http";
import { type Selectable, sql } from "kysely";
import { Redis } from "effect/persistence/Redis";
import { isProduction } from "./config.js";
import type { AppPublicUsers as User } from "../generated/db.js";
import { Sessions, sessionKeyOf } from "./services/sessions.js";
import { rateLimitKeyPrefix } from "./services/rateLimiter.js";
import { Cookies } from "./services/cookies.js";
import { PgRootDB, queriesOn, type DB } from "./db.js";
import { UserRow } from "./rows.js";
import { MailCapture, MailMessage } from "@danielfgray/stompbox/mail";

const UserQuery = S.Struct({
  username: S.optional(S.String),
  email: S.optional(S.String),
  verified: S.optional(S.Literals(["true", "false"])),
  password: S.optional(S.String),
});

const LoginQuery = S.Struct({ ...UserQuery.fields, redirectTo: S.optional(S.String) });

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
class Testing extends Context.Service<Testing>()("postgres-garden/testing", {
  make: Effect.gen(function* () {
    if (yield* isProduction) {
      return yield* Effect.die("testing routes must not run in production");
    }
    const root = queriesOn<DB>(yield* PgRootDB);
    const sessions = yield* Sessions;
    const redis = yield* Redis;
    const sessionKey = yield* sessionKeyOf;
    const rateLimitPrefix = yield* rateLimitKeyPrefix();
    const capture = yield* MailCapture;

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

      const user = yield* root.one(UserRow, (k) =>
        k
          .selectFrom(
            sql<Selectable<User>>`app_private.really_create_user(
                username => ${username}::citext,
                email => ${email}::citext,
                email_is_verified => ${input.verified},
                password => ${input.password ?? "TestUserPassword"}::text
              )`.as("u"),
          )
          .selectAll()
          // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
          .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
      );

      const session = yield* sessions.createSession(user.id);
      return { user, session };
    });

    const deleteKeys = (pattern: string) =>
      redis.send("KEYS", pattern).pipe(
        Effect.flatMap(S.decodeUnknownEffect(S.Array(S.String))),
        Effect.flatMap((keys) => (keys.length > 0 ? redis.send("DEL", ...keys) : Effect.void)),
      );

    const success = { success: true as const };

    return {
      clearTestUsers: root
        .exec((k) => k.deleteFrom("app_public.users").where("username", "like", "test%"))
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
        }),

      register: (body: typeof RegisterBody.Type) =>
        reallyCreateUser({
          username: body.username,
          email: body.email,
          verified: false,
          password: body.password,
        }),

      loginPost: Effect.fn("Testing.loginPost")(function* (body: typeof LoginPostBody.Type) {
        const user = yield* root
          .all(UserRow, (k) =>
            k
              .selectFrom((eb) =>
                eb
                  .fn<Selectable<User>>("app_private.login", [
                    sql`${body.id}::citext`,
                    eb.val(body.password),
                  ])
                  .as("u"),
              )
              .selectAll()
              // @ts-expect-error: Kysely doesn't allow referencing virtual tables directly
              .where((eb) => eb.not(eb(eb.ref("u"), "is", null))),
          )
          .pipe(Effect.head);
        const session = yield* sessions.createSession(user.id);
        return { user, session };
      }),

      createUser: Effect.fn("Testing.createUser")(function* (query: typeof UserQuery.Type) {
        const { user } = yield* reallyCreateUser({
          username: query.username,
          email: query.email,
          verified: query.verified === "true",
          password: query.password,
        });
        return { user };
      }),

      /**
       * The mail the capture provider took for `to`, oldest first. The emailed
       * tokens exist only in the mail, so a test reads its link from here, as a
       * user reads it. The list is empty until the worker sends the mail, and
       * always empty on a server whose `MAIL_PROVIDER` is not `capture`.
       */
      mailTo: (to: string) =>
        Effect.map(capture.sent, (sent) =>
          Arr.filter(sent, (mail) =>
            mail.to.some((address) => address.toLowerCase() === to.toLowerCase()),
          ),
        ),

      verifyUser: (username: string) =>
        root
          .exec((k) =>
            k
              .updateTable("app_public.users")
              .set({ is_verified: true })
              .where("username", "=", username),
          )
          .pipe(Effect.as(success)),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Sessions.layer, Cookies.layer)),
  );
}

const successSchema = S.Struct({ success: S.Boolean });
const UserQuerySchema = S.Struct({
  username: S.optionalKey(S.String),
  email: S.optionalKey(S.String),
  verified: S.optionalKey(S.Literals(["true", "false"])),
  password: S.optionalKey(S.String),
});
const LoginQuerySchema = S.Struct({
  ...UserQuerySchema.fields,
  redirectTo: S.optionalKey(S.String),
});
const MailQuerySchema = S.Struct({ to: S.String });
const UsernameQuerySchema = S.Struct({ username: S.optionalKey(S.String) });
const RegisterBodySchema = S.Struct({
  username: S.String,
  password: S.String.check(S.isMinLength(8)),
  email: S.String.check(S.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
  redirectTo: S.optionalKey(S.String),
});
const LoginPostBodySchema = S.Struct({
  id: S.String,
  password: S.String,
  redirectTo: S.optionalKey(S.String),
});
const SignedInSchema = S.Struct({ username: S.String });
const CreatedUserSchema = S.Struct({
  user: S.Struct({
    id: S.String,
    username: S.String,
    name: S.NullOr(S.String),
    avatar_url: S.NullOr(S.String),
    bio: S.String,
    role: S.Literals(["user", "sponsor", "pro", "admin"]),
    is_verified: S.Boolean,
    created_at: S.DateFromString,
    updated_at: S.DateFromString,
  }),
});
const apiErrors = [InternalError] as const;

const TestingApiGroup = HttpApiGroup.make("TestingApi")
  .add(
    HttpApiEndpoint.get("clearTestUsers", "/clearTestUsers", {
      success: successSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("clearRateLimits", "/clearRateLimits", {
      success: successSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("createUser", "/createUser", {
      query: UserQuerySchema,
      success: CreatedUserSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("mailTo", "/mailTo", {
      query: MailQuerySchema,
      success: S.Array(MailMessage),
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("verifyUser", "/verifyUser", {
      query: UsernameQuerySchema,
      success: successSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("login", "/login", {
      query: LoginQuerySchema,
      success: SignedInSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/register", {
      payload: RegisterBodySchema,
      success: SignedInSchema,
      error: apiErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("loginPost", "/loginPost", {
      payload: LoginPostBodySchema,
      success: SignedInSchema,
      error: apiErrors,
    }),
  );
export const TestingApi = HttpApi.make("TestingApi").add(TestingApiGroup).prefix("/api/testing");
export const TestingApiGroupLive = HttpApiBuilder.group(TestingApi, "TestingApi", (handlers) =>
  Effect.gen(function* () {
    const testing = yield* Testing;
    const cookies = yield* Cookies;
    const signedInResult = (signedIn: {
      readonly username: string;
      readonly session: { readonly token: string; readonly expiresAt: Date };
    }) =>
      cookies
        .setSession(signedIn.session.token, signedIn.session.expiresAt)
        .pipe(Effect.as({ username: signedIn.username }));
    return handlers
      .handle("clearTestUsers", () => testing.clearTestUsers.pipe(Effect.orDie))
      .handle("clearRateLimits", () => testing.clearRateLimits.pipe(Effect.orDie))
      .handle("createUser", ({ query }) => testing.createUser(query).pipe(Effect.orDie))
      .handle("mailTo", ({ query: { to } }) => testing.mailTo(to))
      .handle("verifyUser", ({ query }) =>
        testing.verifyUser(query.username ?? "testuser").pipe(Effect.orDie),
      )
      .handle("login", ({ query }) =>
        testing.login(query).pipe(
          Effect.orDie,
          Effect.flatMap(({ user, session }) =>
            signedInResult({ username: user.username, session }),
          ),
        ),
      )
      .handle("register", ({ payload }) =>
        testing.register(payload).pipe(
          Effect.orDie,
          Effect.flatMap(({ user, session }) =>
            signedInResult({ username: user.username, session }),
          ),
        ),
      )
      .handle("loginPost", ({ payload }) =>
        testing.loginPost(payload).pipe(
          Effect.orDie,
          Effect.flatMap(({ user, session }) =>
            signedInResult({ username: user.username, session }),
          ),
        ),
      );
  }),
);
export const TestingApiLive = HttpApiBuilder.layer(TestingApi).pipe(
  Layer.provide(TestingApiGroupLive),
  Layer.provide(Testing.layer),
  Layer.provide(Cookies.layer),
);
