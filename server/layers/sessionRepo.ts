/**
 * Server-side SessionRepo implementation.
 *
 * Validates session cookie → returns User or null.
 * Uses SessionService (Valkey session store) for token validation.
 */

import { Array as Arr, Effect, Layer, Option, pipe } from "effect";
import { SessionRepo } from "../../src/shared/services.js";
import { User } from "../../src/shared/schemas.js";
import { SessionService, sessionCookieName } from "../services/sessionService.js";
import { RequestContext } from "./requestContext.js";

const parseSessionToken = (cookieHeader: string | null): string | undefined =>
  pipe(
    Option.fromNullable(cookieHeader),
    Option.flatMap((header) =>
      pipe(
        header.split(";"),
        Arr.findFirst((part) => part.trim().split("=")[0] === sessionCookieName),
        Option.map((part) => {
          const [, ...rest] = part.trim().split("=");
          return rest.join("=");
        }),
      ),
    ),
    Option.getOrUndefined,
  );

export const SessionRepoServer = Layer.effect(
  SessionRepo,
  Effect.gen(function* () {
    const ctx = yield* RequestContext;
    const sessionService = yield* SessionService;

    return {
      getCurrentUser: () =>
        Effect.gen(function* () {
          const token = parseSessionToken(ctx.cookieHeader);
          const result = yield* sessionService.validateSessionToken(token);
          if (!result.user) return null;
          return new User({
            id: result.user.id,
            username: result.user.username,
            role: result.user.role,
          });
        }).pipe(Effect.catchAll(() => Effect.succeed(null))),
    };
  }),
);
