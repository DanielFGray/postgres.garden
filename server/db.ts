import { runnerOn } from "@danielfgray/stompbox/db";
import { PgClient } from "@effect/sql-pg";
import { Config, Context, Effect, Layer } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { SqlClient } from "effect/sql/SqlClient";
import { waitFor } from "./dependencies.js";

import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { DB, User, Organization, Playground, Commit };

/** The tables the visitor role reaches: `app_public` only. */
export type PublicDB = Pick<DB, Extract<keyof DB, `app_public.${string}`>>;

/** What `PgClient.make` builds: the client with the PgClient extras and the `SqlClient` surface. */
export type Pool = PgClient.PgClient & SqlClient;

// Shared by both database services so their pool setup stays identical. A
// const, so it is defined before the classes that call it.
const openPool = Effect.fnUntraced(function* (urlKey: string) {
  const url = yield* Config.Redacted(urlKey);
  // The pool opens no connection until the first query, so `make` fails only
  // on a URL it cannot read: a fault in the settings, not a down database.
  const client = yield* PgClient.make({ url }).pipe(Effect.orDie);
  // A first query proves Postgres answers.
  yield* client`select 1`.pipe(waitFor(`postgres (${urlKey})`), Effect.withTracerEnabled(false));
  return client;
});

/**
 * The owning role, which bypasses row-level security. Each query runs on the
 * pool and commits on its own; work that must commit or roll back together
 * runs inside `withTransaction`. Its connections are not the visitor pool's, so
 * a root write inside a request stays committed when the request's transaction
 * rolls back.
 */
export class PgRootDB extends Context.Service<PgRootDB, Pool>()("postgres-garden/db/PgRootDB", {
  make: openPool("DATABASE_URL"),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Reactivity.layer));
}

/**
 * The authenticator login. It has no rights of its own: request code reaches
 * it through `withAuthContext` (server/requestDatabase.ts), which switches each
 * request's transaction to the visitor role.
 */
export class PgAuthDB extends Context.Service<PgAuthDB, Pool>()("postgres-garden/db/PgAuthDB", {
  make: openPool("AUTH_DATABASE_URL"),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Reactivity.layer));
}

export const DatabaseLive = Layer.mergeAll(PgAuthDB.layer, PgRootDB.layer);

/**
 * Queries typed by `Tables`, run on `client`. A service takes `PgRootDB` in its
 * `make` and builds its queries with this, so its methods do not require the
 * pool. Inside `client.withTransaction` they join its transaction.
 */
export const queriesOn = <Tables>(client: SqlClient) =>
  runnerOn<Tables, never>(Effect.succeed(client));

/** What `queriesOn` returns: the typed query runner of a client. */
export type Queries<Tables> = ReturnType<typeof queriesOn<Tables>>;
