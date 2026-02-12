import * as pg from "pg";
import { PostgresDialect, Transaction, Kysely, sql } from "kysely";
import { env } from "./assertEnv.js";
import type {
  DB,
  AppPublicUsers as User,
  AppPublicOrganizations as Organization,
  AppPublicPlaygrounds as Playground,
  AppPublicPlaygroundCommits as Commit,
} from "../generated/db.js";

export type { User, Organization, Playground, Commit };

export const rootPg = new pg.Pool({ connectionString: env.DATABASE_URL });
export const rootDb = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: rootPg }),
});

export const authPg = new pg.Pool({ connectionString: env.AUTH_DATABASE_URL });
export const authDb = new Kysely<DB>({
  dialect: new PostgresDialect({ pool: authPg }),
});

export function withAuthContext<R>(
  sessionId: string | undefined,
  cb: (sql: Transaction<DB>) => Promise<R>,
): Promise<R> {
  return authDb.transaction().execute((tx) =>
    sql`
      select
        set_config('role', ${env.DATABASE_VISITOR}, false),
        set_config('my.session_id', ${sessionId ?? null}, true);
    `
      .execute(tx)
      .then(() => cb(tx)),
  );
}

const CUSTOM_ERROR_CODES = [
  "LOCKD", // Account/process locked
  "WEAKP", // Weak password
  "LOGIN", // Authentication required
  "DNIED", // Access denied
  "CREDS", // Invalid credentials
  "MODAT", // Missing/mandatory data
  "TAKEN", // Already taken/linked
  "EMTKN", // Email taken
  "CDLEA", // Cannot delete last email address
  "VRFY1", // Verification required (email not verified)
  "VRFY2", // Verification required (user account not verified)
  "ISMBR", // Already a member
  "NTFND", // Not found
  "OWNER", // Organization owner constraint
] as const;

export function handleDbError(e: unknown, fallbackMessage: string) {
  if (
    e instanceof pg.DatabaseError &&
    e.code &&
    (CUSTOM_ERROR_CODES as unknown as string[]).includes(e.code)
  ) {
    // Return the exact error message from the database
    return { code: 400, error: e.message };
  }
  console.error(e);
  return { code: 500, error: fallbackMessage };
}
