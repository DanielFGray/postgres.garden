import type { ExtendedResults } from "../constants.js";

/**
 * The `text/html` view of a query result, for renderers that cannot show the
 * JSON output. Every column name, value and message is escaped: they come
 * from the user's SQL and data.
 */
export function renderRowsAsTable(result: ExtendedResults): string {
  if ("error" in result) {
    return `Error: ${escapeHtml(result.error.message || "Unknown error")}`;
  }

  const { rows, fields, statement } = result;
  if (fields.length < 1) {
    return `<table><tbody><tr><td>${escapeHtml(statement || "No results")}</td></tr></tbody></table>`;
  }
  const head = fields.map((col) => `<th>${escapeHtml(col.name)}</th>`).join("");
  const body =
    rows.length < 1
      ? `<tr><td colspan=${fields.length}>No results</td></tr>`
      : rows
          .map(
            (row) =>
              `<tr>${fields
                .map((col) => {
                  const value = row[col.name];
                  return `<td>${value === null ? "<i>null</i>" : escapeHtml(String(value))}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Escapes `text` for the content of an HTML element; a newline becomes `<br>`. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br>");
}
