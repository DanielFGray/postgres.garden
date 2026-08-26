import { sql, type ExpressionBuilder } from "kysely";
import type { AppPublicPlaygrounds, DB } from "../../generated/db.js";

type PlaygroundQueryDB = DB & { p: AppPublicPlaygrounds };

export const publicOnly = <T extends PlaygroundQueryDB, TB extends keyof T & string>(
  eb: ExpressionBuilder<T, TB>,
) => eb(sql.ref("p.privacy"), "=", "public");

export const publicOrOwn = <T extends PlaygroundQueryDB, TB extends keyof T & string>(
  eb: ExpressionBuilder<T, TB>,
) =>
  eb.or([
    eb(sql.ref("p.privacy"), "=", "public"),
    eb(sql.ref("p.user_id"), "=", sql<string>`app_public.current_user_id()`),
    sql<boolean>`exists (
      select 1 from app_public.users
      where id = app_public.current_user_id() and role = 'admin'
    )`,
  ]);
