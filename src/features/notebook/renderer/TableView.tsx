import { DateTime, Option } from "effect";
import { createSignal, onCleanup, For, Show } from "solid-js";
import * as S from "effect/Schema";
import type { SQLResult, SqlValue } from "./types";

/** Safely stringify a cell value, using JSON.stringify for objects */
function stringifyCell(v: SqlValue): string {
  if (v !== null && Object(v) === v) return JSON.stringify(v);
  return JSON.stringify(v) ?? "";
}

// Inline JSON tree for table cells
function JSONCell(props: { value: SqlValue }) {
  const [collapsed, setCollapsed] = createSignal(true);

  const entries = () => {
    const value = props.value;
    if (value === null || Object(value) !== value) return [];
    const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
    return keys.map((key) => ({
      key,
      label: Array.isArray(value) ? `[${key}]` : `"${key}"`,
      child: (value as Record<string, SqlValue>)[key]!,
    }));
  };

  const preview = () =>
    Array.isArray(props.value) ? `[${entries().length}]` : `{${entries().length}}`;

  return (
    <Show
      when={props.value !== null && Object(props.value) === props.value}
      fallback={
        <Show when={props.value !== null} fallback={<span class="json-null">null</span>}>
          <span class="json-scalar">{JSON.stringify(props.value)}</span>
        </Show>
      }
    >
      <div class="json-cell-tree">
        <span
          class="json-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((value) => !value);
          }}
        >
          {collapsed() ? "▶" : "▼"} {preview()}
        </span>
        <Show when={!collapsed()}>
          <div class="json-cell-children">
            <For each={entries()}>
              {(entry) => (
                <div class="json-cell-entry">
                  <span class="json-key">{entry.label}:</span> <JSONCell value={entry.child} />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}

// PostgreSQL type OID mapping
type PgTypeMap = Record<number, string>;

const PG_TYPES: PgTypeMap = {
  16: "boolean",
  20: "bigint",
  21: "smallint",
  23: "integer",
  700: "float4",
  701: "float8",
  1043: "varchar",
  1082: "date",
  1114: "timestamp",
  1184: "timestamptz",
  114: "json",
  3802: "jsonb",
  25: "text",
  1700: "numeric",
};

interface CellProps {
  value: SqlValue;
  typeId?: number;
}

function formatCellValue(value: SqlValue, typeId: number | undefined) {
  if (value === null) {
    return <i class="null">null</i>;
  }

  const typeName = typeId ? PG_TYPES[typeId] : null;

  switch (typeName) {
    case "boolean":
      return <span class="boolean">{value ? "true" : "false"}</span>;

    case "date":
    case "timestamp":
    case "timestamptz":
      return Option.match(DateTime.make(value as string | number), {
        onNone: () => stringifyCell(value),
        onSome: (dt) => <span class="date">{DateTime.toDate(dt).toLocaleString()}</span>,
      });

    case "json":
    case "jsonb":
      return Option.match(
        S.is(S.String)(value)
          ? (S.decodeOption(S.fromJsonString(S.Unknown))(value) as Option.Option<SqlValue>)
          : Option.some(value),
        {
          onNone: () => stringifyCell(value),
          onSome: (parsed) => <JSONCell value={parsed} />,
        },
      );

    case "integer":
    case "bigint":
    case "smallint":
    case "float4":
    case "float8":
    case "numeric":
      return <span class="number">{stringifyCell(value)}</span>;

    default:
      return stringifyCell(value);
  }
}

function Cell(props: CellProps) {
  return (
    <td>
      <div class="cell-content">{formatCellValue(props.value, props.typeId) as never}</div>
    </td>
  );
}

export function TableView(props: { data: SQLResult }) {
  const [columnWidths, setColumnWidths] = createSignal<Record<string, number>>({});
  const [resizingColumn, setResizingColumn] = createSignal<string | null>(null);
  let resizeStart = { x: 0, width: 0 };

  // The listeners live for the component's lifetime and no-op unless a drag is
  // active — the drag state is the guard, so no effect has to add/remove them.
  const handleMove = (event: MouseEvent) => {
    const column = resizingColumn();
    if (!column) return;
    const width = Math.max(50, resizeStart.width + event.pageX - resizeStart.x);
    setColumnWidths((value) => ({ ...value, [column]: width }));
  };
  const handleUp = () => setResizingColumn(null);

  document.addEventListener("mousemove", handleMove);
  document.addEventListener("mouseup", handleUp);
  onCleanup(() => {
    document.removeEventListener("mousemove", handleMove);
    document.removeEventListener("mouseup", handleUp);
  });

  const handleMouseDown = (fieldName: string, currentWidth: number) => (e: MouseEvent) => {
    e.preventDefault();
    setResizingColumn(fieldName);
    resizeStart = { x: e.pageX, width: currentWidth };
  };

  return (
    <div class="table-container">
      <table class="sql-table">
        <thead>
          <tr>
            <For each={props.data.fields}>
              {(field) => {
                const width = () => columnWidths()[field.name];
                return (
                  <th style={width() ? { width: `${String(width())}px` } : undefined}>
                    {field.name}
                    <div
                      class={`resize-handle ${resizingColumn() === field.name ? "resizing" : ""}`}
                      onMouseDown={handleMouseDown(field.name, width() || 150)}
                    />
                  </th>
                );
              }}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show
            when={props.data.rows.length > 0}
            fallback={
              <tr>
                <td colspan={props.data.fields.length} class="empty">
                  No results
                </td>
              </tr>
            }
          >
            <For each={props.data.rows}>
              {(row) => (
                <tr>
                  <For each={props.data.fields}>
                    {(field) => <Cell value={row[field.name] ?? null} typeId={field.dataTypeID} />}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}
