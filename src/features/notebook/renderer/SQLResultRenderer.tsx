import { lazy, Errored, Loading, Show } from "solid-js";
import { TableView } from "./TableView";
import type { RendererProps, SqlValue } from "./types";

// pev2 drags in Vue and bootstrap, so defer evaluating it until a plan is
// actually rendered. The renderer bundle inlines dynamic imports, so this
// defers module execution rather than producing a separate chunk.
const ExplainView = lazy(() =>
  import("./ExplainView").then((module) => ({ default: module.ExplainView })),
);

function isExplainResult(rows: Array<Record<string, SqlValue>>): boolean {
  if (rows.length === 0) return false;
  const firstRow = rows[0]!;
  // PostgreSQL EXPLAIN output has "QUERY PLAN" column
  return "QUERY PLAN" in firstRow || "query plan" in firstRow || "Plan" in firstRow;
}

export function SQLResultRenderer(props: RendererProps) {
  return (
    <div class="sql-result-renderer">
      <div class="content">
        <Show when={isExplainResult(props.data.rows)} fallback={<TableView data={props.data} />}>
          <Errored
            fallback={(error) => <div class="explain-error">Failed to load: {String(error())}</div>}
          >
            <Loading fallback={<div class="explain-loading">Loading visualizer...</div>}>
              <ExplainView data={props.data} />
            </Loading>
          </Errored>
        </Show>
      </div>
    </div>
  );
}
