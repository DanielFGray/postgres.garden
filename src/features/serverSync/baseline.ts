/**
 * The baseline is the workspace as it was when it was last loaded, saved or
 * restored. Quick diff marks each line of a file that differs from it, the way
 * Git marks lines that differ from HEAD.
 */

import * as vscode from "vscode";

const scheme = "server-sync-baseline";

/** Where quick diff reads the baseline of the workspace file `file`. */
const baselineUri = (file: vscode.Uri) => vscode.Uri.parse(`${scheme}:${file.path}`);

/** Serves each file's baseline to quick diff. */
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  static readonly scheme = scheme;

  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;

  constructor(
    /** The baseline of the file at `path`. A file the baseline does not hold reads as empty. */
    private readonly read: (path: string) => Promise<string>,
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.read(uri.path);
  }

  /** Makes quick diff read the baseline of `file` again. */
  refresh(file: vscode.Uri): void {
    this.changes.fire(baselineUri(file));
  }

  dispose(): void {
    this.changes.dispose();
  }
}

export const quickDiffProvider: vscode.QuickDiffProvider = {
  provideOriginalResource: baselineUri,
};
