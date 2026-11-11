import { Config, Context, Effect } from "effect";
import { sql } from "kysely";

import { CurrentSession } from "../shared/session.js";
import { type DbHandle, type PublicDB, PgAuthDB } from "./db.js";

/**
 * The connection a visitor-scoped service queries. Only `withAuthContext`
 * provides it: the authenticator transaction, switched to the visitor role, for
 * one request. Its type holds only `app_public` tables.
 *
 * @effect-leakable-service: each request has its own, so a service method
 * requires it per call instead of resolving it when its layer is built.
 */
export class RequestDatabase extends Context.Service<RequestDatabase, DbHandle<PublicDB>>()(
  "RequestDatabase",
) {}

/**
 * Runs `effect` as the visitor role, in one transaction, with the request's
 * session bound for RLS. Both settings are transaction-local, so a pooled
 * connection cannot leak one visitor's identity into the next request.
 *
 * The session comes from `CurrentSession`, which `SessionMiddleware` resolves
 * from the cookie before the handler runs.
 */
export const withAuthContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const auth = yield* PgAuthDB;
    const databaseVisitor = yield* Config.String("DATABASE_VISITOR").pipe(Effect.orDie);
    const { session } = yield* CurrentSession;

    return yield* auth.transaction((trx) =>
      Effect.gen(function* () {
        yield* trx.all(
          trx.connection.selectNoFrom((eb) => [
            eb
              .fn<string>("set_config", [sql.lit("role"), sql.lit(databaseVisitor), eb.lit(true)])
              .as("_1"),
            eb
              .fn<string>("set_config", [
                sql.lit("my.session_id"),
                eb.val(session?.id ?? null),
                eb.lit(true),
              ])
              .as("_2"),
          ]),
        );
        return yield* effect.pipe(Effect.provideService(RequestDatabase, trx));
      }),
    );
  });
