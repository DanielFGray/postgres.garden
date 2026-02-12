import { useSignal, useComputed } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { SQLResult } from "./types";

/** Safely stringify a cell value, using JSON.stringify for objects */
function stringifyCell(v: unknown): string {
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

// Inline JSON tree for table cells
function JSONCell({ value }: { value: unknown }) {
  const collapsed = useSignal(true);

  if (value === null) {
    return <span class="json-null">null</span>;
  }

  if (typeof value !== "object") {
    const type = typeof value;
    return <span class={`json-${type}`}>{JSON.stringify(value)}</span>;
  }

  const isArray = Array.isArray(value);
  const keys = isArray ? value.map((_, i) => i) : Object.keys(value);
  const preview = isArray ? `[${keys.length}]` : `{${keys.length}}`;

  return (
    <div class="json-cell-tree">
      <span
        class="json-toggle"
        onClick={(e) => {
          e.stopPropagation();
          collapsed.value = !collapsed.value;
        }}
      >
        {collapsed.value ? "▶" : "▼"} {preview}
      </span>
      {!collapsed.value && (
        <div class="json-cell-children">
          {keys.map((key) => (
            <div key={key} class="json-cell-entry">
              <span class="json-key">{isArray ? `[${key}]` : `"${key}"`}:</span>{" "}
              <JSONCell value={(value as Record<string, unknown>)[key]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// PostgreSQL type OID mapping
const PG_TYPES: Record<number, string> = {
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
  value: unknown;
  typeId?: number;
}

function Cell({ value, typeId }: CellProps) {
  const stringValue = value === null ? null : stringifyCell(value);

  const formattedValue = useComputed(() => {
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
        try {
          const date = new Date(value as string | number);
          return <span class="date">{date.toLocaleString()}</span>;
        } catch {
          return stringifyCell(value);
        }

      case "json":
      case "jsonb":
        try {
          const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
          return <JSONCell value={parsed} />;
        } catch {
          return stringifyCell(value);
        }

      case "integer":
      case "bigint":
      case "smallint":
      case "float4":
      case "float8":
      case "numeric":
        return <span class="number">{stringifyCell(value)}</span>;

      default:
        return stringValue;
    }
  });

  return (
    <td>
      <div class="cell-content">
        {formattedValue.value}
      </div>
    </td>
  );
}

export function TableView({ data }: { data: SQLResult }) {
  const columnWidths = useSignal<Record<string, number>>({});
  const resizingColumn = useSignal<string | null>(null);
  const startX = useSignal(0);
  const startWidth = useSignal(0);
  const tableRef = useRef<HTMLTableElement>(null);

  const handleMouseDown =
    (fieldName: string, currentWidth: number) => (e: MouseEvent) => {
      e.preventDefault();
      resizingColumn.value = fieldName;
      startX.value = e.pageX;
      startWidth.value = currentWidth;
    };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (resizingColumn.value) {
        const diff = e.pageX - startX.value;
        const newWidth = Math.max(50, startWidth.value + diff);
        columnWidths.value = {
          ...columnWidths.value,
          [resizingColumn.value]: newWidth,
        };
      }
    };

    const handleMouseUp = () => {
      resizingColumn.value = null;
    };

    if (!resizingColumn.value) return;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizingColumn.value]);

  return (
    <div class="table-container">
      <table class="sql-table" ref={tableRef}>
        <thead>
          <tr>
            {data.fields.map((field) => {
              const width = columnWidths.value[field.name];
              return (
                <th
                  key={field.name}
                  style={{ width: width ? `${width}px` : undefined }}
                >
                  {field.name}
                  <div
                    class={`resize-handle ${resizingColumn.value === field.name ? "resizing" : ""}`}
                    onMouseDown={handleMouseDown(field.name, width || 150)}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <td colspan={data.fields.length} class="empty">
                No results
              </td>
            </tr>
          ) : (
            data.rows.map((row, i) => (
              <tr key={i}>
                {data.fields.map((field) => (
                  <Cell
                    key={field.name}
                    value={row[field.name]}
                    typeId={field.dataTypeID}
                  />
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
