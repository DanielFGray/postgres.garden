import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sql } from "kysely";

import { CurrentSession } from "../shared/session.js";
import { type DbHandle, type PublicDB, PgAuthDB } from "./db.js";
import { RequestDatabase, withAuthContext } from "./requestDatabase.js";

const roleOf = (handle: DbHandle<PublicDB>) =>
  handle
    .all(handle.raw<{ role: string }>(sql`select current_user as role`))
    .pipe(Effect.map((rows) => rows.map((row) => row.role)));

const poolRole = PgAuthDB.use(roleOf);

// The visitor handle has no app_private tables in its type.
export const visitorCannotReachPrivate = RequestDatabase.use((db) =>
  // @ts-expect-error app_private is reachable only through PgRootDB
  db.all(db.connection.selectFrom("app_private.sessions").selectAll()),
);

it.effect("withAuthContext leaves the pooled connection in its login role", () =>
  Effect.gen(function* () {
    const loginRole = yield* poolRole;
    const visitorRole = yield* withAuthContext(RequestDatabase.use(roleOf));
    expect(visitorRole).not.toEqual(loginRole);
    // pg's pool hands out the most recently released idle client, so this
    // query runs on the connection the transaction just used.
    expect(yield* poolRole).toEqual(loginRole);
  }).pipe(
    Effect.provideService(CurrentSession, { user: null, session: null }),
    Effect.provide(PgAuthDB.layer),
  ),
);
