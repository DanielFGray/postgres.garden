import { TableView } from "./TableView";
import { ExplainViewLazy } from "./ExplainViewLazy";
import type { RendererProps } from "./types";

function isExplainResult(rows: Array<Record<string, unknown>>): boolean {
  if (rows.length === 0) return false;
  const firstRow = rows[0]!;
  // PostgreSQL EXPLAIN output has "QUERY PLAN" column
  return "QUERY PLAN" in firstRow || "query plan" in firstRow || "Plan" in firstRow;
}

export function SQLResultRenderer({ data }: RendererProps) {
  const hasExplainData = isExplainResult(data.rows);

  return (
    <div class="sql-result-renderer">
      <div class="content">
        {hasExplainData ? <ExplainViewLazy data={data} /> : <TableView data={data} />}
      </div>
    </div>
  );
}
