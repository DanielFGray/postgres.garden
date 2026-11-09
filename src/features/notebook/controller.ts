import * as vscode from "vscode";
import { toErrorMessage } from "../../shared/errors.js";
import { PGLITE_EXECUTE, type ExtendedResults } from "../constants.js";

export class SQLNotebookExecutionController {
  readonly #controller: vscode.NotebookController;
  #executionOrder = 0;
  constructor(type: string) {
    const controller = vscode.notebooks.createNotebookController(
      `${type}-controller`,
      type,
      "SQL Notebook",
    );
    controller.supportedLanguages = ["sql", "SQL"];
    controller.supportsExecutionOrder = true;
    controller.executeHandler = this.#execute.bind(this);
    this.#controller = controller;
  }

  dispose(): void {
    this.#controller.dispose();
  }

  #execute(cells: vscode.NotebookCell[]): void {
    void this.runAll(cells);
  }

  /**
   * Runs cells one at a time, in the given order, stopping at the first
   * failure — later cells may depend on DDL/DML from earlier ones.
   */
  runAll(cells: readonly vscode.NotebookCell[]): Promise<boolean> {
    return cells.reduce<Promise<boolean>>(
      (prev, cell) => prev.then((ok) => (ok ? this.#doExecution(cell) : false)),
      Promise.resolve(true),
    );
  }

  #doExecution(cell: vscode.NotebookCell): Promise<boolean> {
    const execution = this.#controller.createNotebookCellExecution(cell);
    const text = cell.document.getText();
    if (text.trim().length < 1) return Promise.resolve(true);
    execution.executionOrder = ++this.#executionOrder;
    execution.start(performance.now());
    return Promise.resolve(
      vscode.commands.executeCommand<ExtendedResults[]>(PGLITE_EXECUTE, text),
    ).then(
      (results) => {
        if (!results || !Array.isArray(results)) {
          execution.replaceOutput([
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text("No results returned", "text/markdown"),
            ]),
          ]);
          execution.end(false, performance.now());
          return false;
        }
        const hasError = results.some((r) => "error" in r);
        execution.replaceOutput(
          results.map((result) => {
            if ("error" in result) {
              return errorOutput(result.error.message);
            }
            if (result.fields.length > 0) {
              return new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json(
                  { ...result, query: text },
                  "application/vnd.pg-playground.sql-result+json",
                ),
                vscode.NotebookCellOutputItem.text(renderRowsAsTable(result), "text/html"),
              ]);
            }
            // Show success message for statements that don't return rows
            const message = result.statement || "Query executed successfully";
            const affectedInfo =
              result.affectedRows !== undefined && result.affectedRows >= 0
                ? ` (${result.affectedRows} rows affected)`
                : "";
            return new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(`✓ ${message}${affectedInfo}`, "text/markdown"),
            ]);
          }),
        );
        execution.end(!hasError, performance.now());
        return !hasError;
      },
      (err) => {
        execution.replaceOutput([errorOutput(toErrorMessage(err))]);
        execution.end(false, performance.now());
        return false;
      },
    );
  }
}

/**
 * The markdown renderer passes raw HTML through, so the message is escaped:
 * Postgres errors often quote user input such as `<tag>`. A blank line would
 * end the HTML block, so newlines become `<br>`.
 */
function errorOutput(message: string): vscode.NotebookCellOutput {
  const text = message.trim() === "" ? "Unknown error" : escapeHtml(message);
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.text(
      `<div style="box-sizing:border-box;font-weight:550;padding:0.25em 0.5em;color:var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);">${text}</div>`,
      "text/markdown",
    ),
  ]);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\n", "<br>");
}

function renderRowsAsTable(result: ExtendedResults): string {
  if ("error" in result) {
    return `Error: ${result.error?.message ?? "Unknown error"}`;
  }

  const { rows, fields, statement } = result;
  return `<table>${
    fields.length < 1
      ? null
      : `<thead><tr>${fields.map((col) => `<th>${col.name}</th>`).join("")}</tr></thead>`
  }<tbody>${
    fields.length < 1
      ? `<tr><td>${statement || "No results"}</td></tr>`
      : rows.length < 1
        ? `<tr><td colspan=${fields.length}>No results</td></tr>`
        : rows
            .map(
              (row) =>
                `<tr>${fields
                  .map(
                    (col) => `<td>${row[col.name] === null ? "<i>null</i>" : row[col.name]}</td>`,
                  )
                  .join("")}</tr>`,
            )
            .join("")
  }</tbody></table>`;
}
