import { Config, Duration, Effect, Layer, Match, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { RateLimiter, type RateLimiterError } from "effect/persistence/RateLimiter";
import { CurrentSession, RateLimitMiddleware } from "./apiSchema.js";
import { networkOf } from "./clientIp.js";
import { TooManyRequests } from "./errors.js";
import { storeTimeout } from "./services/rateLimiter.js";

/**
 * Per-caller limits on the endpoints that send email, check a secret or cost
 * a password hash. The key is `group:endpoint` plus the caller: the network
 * the request came from (`ip`), or the signed-in user (`user`; a visitor with
 * no session falls back to the network).
 *
 * An endpoint is limited only if its contract adds `RateLimitMiddleware`, and
 * every endpoint that adds it must have a rule here (rateLimit.test.ts).
 */
interface Rule {
  readonly by: "ip" | "user";
  readonly limit: number;
  readonly window: Duration.Input;
  /**
   * What to do when the store cannot answer. Deny where the endpoint sends
   * email or lets a caller choose the recipient, since an open gate there is
   * the abuse. Allow on login and the other secret checks, so an outage does
   * not lock everyone out.
   */
  readonly whenStoreDown: "allow" | "deny";
}

export const rules = {
  "auth:login": { by: "ip", limit: 10, window: "5 minutes", whenStoreDown: "allow" },
  "auth:register": { by: "ip", limit: 5, window: "1 hour", whenStoreDown: "deny" },
  "apiUsers:forgotPassword": { by: "ip", limit: 5, window: "1 hour", whenStoreDown: "deny" },
  "apiUsers:resetPassword": { by: "ip", limit: 10, window: "1 hour", whenStoreDown: "allow" },
  "apiUsers:verifyEmail": { by: "ip", limit: 20, window: "1 hour", whenStoreDown: "allow" },
  "apiUsers:changePassword": { by: "user", limit: 10, window: "1 hour", whenStoreDown: "allow" },
  "apiUsers:createMeEmail": { by: "user", limit: 5, window: "1 day", whenStoreDown: "deny" },
  "apiUsers:resendEmailVerificationCode": {
    by: "user",
    limit: 5,
    window: "1 day",
    whenStoreDown: "deny",
  },
  // One endpoint both requests deletion (it sends an email) and confirms it
  // (it checks the emailed token), so one count covers a request, its
  // confirmation and a few retries.
  "apiUsers:deleteMe": { by: "user", limit: 5, window: "1 day", whenStoreDown: "deny" },
} as const satisfies Record<string, Rule>;

const ruleByKey: ReadonlyMap<string, Rule> = new Map(Object.entries(rules));

/** For tests that must not hit real caps. */
export const RateLimitMiddlewarePassThrough = Layer.succeed(
  RateLimitMiddleware,
  (effect) => effect,
);

/**
 * The enforcing middleware. It counts against the `RateLimiter` in context:
 * `RateLimiterValkey` in the server, `RateLimiterMemory` in tests.
 */
export const RateLimitMiddlewareLive = Layer.effect(
  RateLimitMiddleware,
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    // A header is trustworthy only when a reverse proxy overwrites it and is the
    // only public listener; otherwise any client can forge it. Unset, the socket
    // address is the caller.
    const trustedHeader = yield* Config.option(Config.String("TRUSTED_PROXY_HEADER"));

    const network = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const address = Option.match(trustedHeader, {
        onNone: () => request.remoteAddress,
        onSome: (header) => Option.fromNullishOr(request.headers[header.toLowerCase()]),
      });
      return Option.match(address, { onNone: () => "unknown", onSome: networkOf });
    });

    const caller = Effect.fnUntraced(function* (rule: Rule) {
      if (rule.by === "user") {
        const { user } = yield* CurrentSession;
        if (user) return `user:${user.id}`;
      }
      return `ip:${yield* network}`;
    });

    return (effect, { endpoint, group }) => {
      const ruleKey = `${group.identifier}:${endpoint.identifier}`;
      return Option.match(Option.fromNullishOr(ruleByKey.get(ruleKey)), {
        onNone: () => effect,
        onSome: (rule) =>
          caller(rule).pipe(
            Effect.flatMap((who) =>
              limiter.consume({
                key: `${ruleKey}:${who}`,
                limit: rule.limit,
                window: rule.window,
                onExceeded: "fail",
              }),
            ),
            Effect.timeout(storeTimeout),
            Effect.catchTags({
              RateLimiterError: (error) => deny(rule, error),
              TimeoutError: () => storeDown(rule, "timed out"),
            }),
            Effect.andThen(effect),
          ),
      });
    };
  }),
);

const deny = (rule: Rule, error: RateLimiterError) =>
  Match.value(error.reason).pipe(
    Match.tag("RateLimitExceeded", (exceeded) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(Duration.toSeconds(exceeded.retryAfter)));
      return Effect.fail(
        new TooManyRequests({
          error: `Too many attempts. Try again in ${Duration.format(Duration.seconds(retryAfterSeconds))}.`,
          retryAfterSeconds,
        }),
      );
    }),
    Match.tag("RateLimitStoreError", (failure) => storeDown(rule, failure.message)),
    Match.exhaustive,
  );

const storeDown = (rule: Rule, reason: string) =>
  Effect.logWarning("Rate limiter store unavailable", reason).pipe(
    Effect.andThen(
      rule.whenStoreDown === "allow"
        ? Effect.void
        : Effect.fail(
            new TooManyRequests({ error: "Try again in a minute.", retryAfterSeconds: 60 }),
          ),
    ),
  );
