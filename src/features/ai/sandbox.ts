/** Path rules for agent tools: every path resolves under the workspace folder. */

import { Effect, Option } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";

export class PathOutsideWorkspaceError extends S.TaggedError<
  PathOutsideWorkspaceError,
  { readonly brand: unique symbol }
>()("PathOutsideWorkspaceError", { path: S.String }) {
  override get message() {
    return `Path ${this.path} is outside the active workspace folder.`;
  }
}

export const activeWorkspaceRoot = (vscodeApi: typeof vscode) =>
  Option.fromNullishOr(vscodeApi.workspace.workspaceFolders?.[0]?.uri);

/**
 * Resolve a model-supplied path under `root`. A path may be relative or
 * start with the root's own path; `.` and `..` segments and other schemes
 * are refused rather than normalized, so no spelling can leave the folder.
 */
export const resolveWorkspacePath = (vscodeApi: typeof vscode, root: vscode.Uri, path: string) => {
  const rootPrefix = `${root.path.replace(/\/$/, "")}/`;
  const relative = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  const escapes =
    relative.includes(":") ||
    relative.includes("\\") ||
    segments.some((segment) => segment === "." || segment === "..");
  return Effect.gen(function* () {
    if (escapes) return yield* new PathOutsideWorkspaceError({ path });
    return vscodeApi.Uri.joinPath(root, ...segments);
  });
};

/** The path shown to the model: relative to `root`, `.` for the root. */
export const workspaceRelativePath = (root: vscode.Uri, uri: vscode.Uri) =>
  uri.path.slice(root.path.replace(/\/$/, "").length).replace(/^\//, "") || ".";
