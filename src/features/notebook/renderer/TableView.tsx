import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import type { SQLResult } from "./types";

/** Safely stringify a cell value, using JSON.stringify for objects */
function stringifyCell(v: unknown): string {
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

// Inline JSON tree for table cells
function JSONCell({ value }: { value: unknown }) {
  // Each JSONCell instance needs its own collapsed atom
  const collapsedAtom = Atom.make(true);

  return Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const collapsed = yield* Atom.get(collapsedAtom);

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
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            registry.set(collapsedAtom, !registry.get(collapsedAtom));
          }}
        >
          {collapsed ? "\u25B6" : "\u25BC"} {preview}
        </span>
        {!collapsed && (
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
  });
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

function formatCellValue(value: unknown, typeId: number | undefined): unknown {
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
      return stringifyCell(value);
  }
}

function Cell({ value, typeId }: CellProps) {
  const formatted = formatCellValue(value, typeId);

  return (
    <td>
      <div class="cell-content">
        {formatted}
      </div>
    </td>
  );
}

// Module-level atoms for column resizing state
const columnWidthsAtom = Atom.make<Record<string, number>>({});
const resizingColumnAtom = Atom.make<string | null>(null);

let resizeInitialized = false;
let startX = 0;
let startWidth = 0;

export function TableView({ data }: { data: SQLResult }) {
  return Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const columnWidths = yield* Atom.get(columnWidthsAtom);
    const resizingColumn = yield* Atom.get(resizingColumnAtom);

    if (!resizeInitialized) {
      resizeInitialized = true;

      document.addEventListener("mousemove", (e: MouseEvent) => {
        const col = registry.get(resizingColumnAtom);
        if (col) {
          const diff = e.pageX - startX;
          const newWidth = Math.max(50, startWidth + diff);
          registry.set(columnWidthsAtom, {
            ...registry.get(columnWidthsAtom),
            [col]: newWidth,
          });
        }
      });

      document.addEventListener("mouseup", () => {
        registry.set(resizingColumnAtom, null);
      });
    }

    const handleMouseDown =
      (fieldName: string, currentWidth: number) => (e: MouseEvent) => {
        e.preventDefault();
        registry.set(resizingColumnAtom, fieldName);
        startX = e.pageX;
        startWidth = currentWidth;
      };

    return (
      <div class="table-container">
        <table class="sql-table">
          <thead>
            <tr>
              {data.fields.map((field) => {
                const width = columnWidths[field.name];
                return (
                  <th
                    key={field.name}
                    style={{ width: width ? `${String(width)}px` : undefined }}
                  >
                    {field.name}
                    <div
                      class={`resize-handle ${resizingColumn === field.name ? "resizing" : ""}`}
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
  });
}
