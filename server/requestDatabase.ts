import { runnerOn, toDatabaseError } from "@danielfgray/stompbox/db";
import type { DatabaseError } from "@danielfgray/stompbox/db";
import { ServiceUnavailable } from "@danielfgray/stompbox/http";
import { Cause, Config, Context, Effect, Option } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

import { CurrentSession } from "../shared/session.js";
import { PgAuthDB, queriesOn, type PublicDB } from "./db.js";

/**
 * The connection a visitor-scoped service queries. Only `withAuthContext`
 * provides it: the authenticator's pool, inside the request's transaction,
 * which is switched to the visitor role.
 *
 * @effect-leakable-service: each request has its own, so a service method
 * requires it per call instead of resolving it when its layer is built.
 */
/** @perRequest */
export class RequestDatabase extends Context.Service<RequestDatabase, SqlClient>()(
  "postgres-garden/requestDatabase",
) {}

/**
 * Queries typed by the tables the visitor role can reach, run on the request's
 * transaction. A query on an `app_private` table does not compile.
 */
export const requestDb = runnerOn<PublicDB, RequestDatabase>(Effect.service(RequestDatabase));

/**
 * Runs `effect` as the visitor role, in one transaction, with the request's
 * session bound for RLS. Both settings are transaction-local, so a pooled
 * connection cannot leak one visitor's identity into the next request. Every
 * query of `effect` joins the transaction, because `SqlClient` keeps the open
 * transaction in the fiber.
 *
 * The session comes from `CurrentSession`, which `SessionMiddleware` resolves
 * from the cookie before the handler runs.
 */
export const withAuthContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const auth = yield* PgAuthDB;
    const databaseVisitor = yield* Config.String("DATABASE_VISITOR").pipe(Effect.orDie);
    const { session } = yield* CurrentSession;

    return yield* auth.withTransaction(
      Effect.gen(function* () {
        yield* queriesOn<PublicDB>(auth)
          .exec((k) =>
            k.selectNoFrom((eb) => [
              eb.fn("set_config", [eb.val("role"), eb.val(databaseVisitor), eb.lit(true)]).as("_1"),
              eb
                .fn("set_config", [
                  eb.val("my.session_id"),
                  eb.val(session?.id ?? null),
                  eb.lit(true),
                ])
                .as("_2"),
            ]),
          )
          .pipe(Effect.catchTag("DatabaseError", refusedRoleSwitch(databaseVisitor)));
        return yield* effect.pipe(Effect.provideService(RequestDatabase, auth));
      }),
    );
  }).pipe(toDatabaseError);

/**
 * A refused switch to the visitor role is a fault in the server's settings:
 * `DATABASE_VISITOR` names no role (22023), or a role the authenticator is not
 * a member of (42501). It answers 503 here, before `toHttpError`
 * (server/databaseErrors.ts), whose table reads 42501 as a row that row-level
 * security refused (403) and 22023 as bad input (400). Any other failure goes
 * on to that table.
 */
const refusedRoleSwitch = (role: string) =>
  Effect.fnUntraced(function* (error: DatabaseError) {
    const refused = Option.exists(error.report, ({ code }) => roleSwitchRefusals.has(code));
    if (!refused) return yield* error;
    yield* Effect.logError(`Could not switch to the visitor role '${role}'`, Cause.fail(error));
    return yield* new ServiceUnavailable({
      message: "The service is not available right now.",
      reason: "misconfigured",
    });
  });

const roleSwitchRefusals = new Set(["42501", "22023"]);
