import * as vscode from "vscode";
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
    cells.forEach((cell) => {
      void this.#doExecution(cell);
    });
  }

  async #doExecution(cell: vscode.NotebookCell): Promise<void> {
    const execution = this.#controller.createNotebookCellExecution(cell);
    const text = cell.document.getText();
    if (text.trim().length < 1) return;
    execution.executionOrder = ++this.#executionOrder;
    execution.start(Date.now());
    try {
      const results = await vscode.commands.executeCommand<ExtendedResults[]>(PGLITE_EXECUTE, text);
      if (!results || !Array.isArray(results)) {
        execution.replaceOutput([
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text("No results returned", "text/markdown"),
          ]),
        ]);
        execution.end(false, Date.now());
        return;
      }
      const hasError = results.some((r) => "error" in r);
      execution.replaceOutput(
        results.map((result) => {
          if ("error" in result) {
            return new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(
                `<div style="font-weight:550;background:#f009;padding:0.25em;color:white;">${result.error?.message ?? "Unknown error"}</div>`,
                "text/markdown",
              ),
            ]);
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
      execution.end(!hasError, Date.now());
    } catch (err) {
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(
            `<div style="font-weight:550;background:#f009;padding:0.25em;color:white;">${err instanceof Error ? err.message : String(err)}</div>`,
            "text/markdown",
          ),
        ]),
      ]);
      execution.end(false, Date.now());
    }
  }
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
