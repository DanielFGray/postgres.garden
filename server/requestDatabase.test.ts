import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { type Kysely, sql } from "kysely";

import { CurrentSession } from "../shared/session.js";
import { PgAuthDB, queriesOn, type DB } from "./db.js";
import { requestDb, withAuthContext } from "./requestDatabase.js";

const RoleRow = Schema.Struct({ role: Schema.String });

const currentRole = <Tables>(k: Kysely<Tables>) =>
  k.selectNoFrom(sql<string>`current_user`.as("role"));
const roleNames = (rows: ReadonlyArray<typeof RoleRow.Type>) => rows.map((row) => row.role);

const poolRole = PgAuthDB.use((pool) =>
  queriesOn<DB>(pool).all(RoleRow, currentRole).pipe(Effect.map(roleNames)),
);

// The visitor runner has no app_private tables in its type.
export const visitorCannotReachPrivate = requestDb.all(Schema.Struct({}), (k) =>
  // @ts-expect-error app_private is reachable only through PgRootDB
  k.selectFrom("app_private.sessions").selectAll(),
);

it.effect("withAuthContext leaves the pooled connection in its login role", () =>
  Effect.gen(function* () {
    const loginRole = yield* poolRole;
    const visitorRole = yield* withAuthContext(
      requestDb.all(RoleRow, currentRole).pipe(Effect.map(roleNames)),
    );
    expect(visitorRole).not.toEqual(loginRole);
    // The pool hands out the most recently released idle connection, so this
    // query runs on the connection the transaction just used.
    expect(yield* poolRole).toEqual(loginRole);
  }).pipe(
    Effect.provideService(CurrentSession, { user: null, session: null }),
    Effect.provide(PgAuthDB.layer),
  ),
);
