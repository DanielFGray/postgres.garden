import { templateHack } from "../../../lib/index.js";
import type { QueryOptions } from "@electric-sql/pglite";

const sql = templateHack;

export interface ERDQueryClient {
  query<T>(sql: string, params?: unknown[], opts?: QueryOptions): Promise<{ rows: readonly T[] }>;
}

export async function getMermaidERD(service: ERDQueryClient) {
  const result = await service.query<{ erd: string }>(sql`
    select 'erDiagram' as erd

    union all

    select
      format(E'\t%s{\n%s\n}',
        c.relname,
        string_agg(format(E'\t\t~%s~ %s',
          format_type(t.oid, a.atttypmod),
          a.attname
        ), E'\n'))
    from
      pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attribute a on c.oid = a.attrelid and a.attnum > 0 and not a.attisdropped
      left join pg_type t on a.atttypid = t.oid
    where
      c.relkind in ('r', 'p')
      and not c.relispartition
      and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
    group by c.relname

    union all

    select
      format('%s }|..|| %s : %s', c1.relname, c2.relname, c.conname)
    from
      pg_constraint c
      join pg_class c1 on c.conrelid = c1.oid and c.contype = 'f'
      join pg_class c2 on c.confrelid = c2.oid
    where
      not c1.relispartition and not c2.relispartition;
  `);
  return result.rows.map((r: { erd: string }) => r.erd).join("\n");
}
