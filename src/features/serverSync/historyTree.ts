/**
 * The commit history and fork history views. Each is a flat list that the
 * view loads again whenever it is refreshed.
 */

import * as vscode from "vscode";
import { DateTime, Option } from "effect";
import { SERVER_SYNC_VIEW_COMMIT, SERVER_SYNC_VIEW_FORK_SOURCE } from "../constants";

/** A tree view of one flat list, loaded by `load` each time it is refreshed. */
export class ListTreeProvider<Item> implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(
    private readonly load: () => Promise<Item[]>,
    readonly getTreeItem: (item: Item) => vscode.TreeItem,
  ) {}

  getChildren(parent?: Item): Promise<Item[]> {
    // The list is flat: only the root has children.
    return parent === undefined ? this.load() : Promise.resolve([]);
  }

  refresh(): void {
    this.changes.fire();
  }

  dispose(): void {
    this.changes.dispose();
  }
}

/** One commit of the playground the workspace holds. */
export interface CommitHistoryItem {
  readonly id: string;
  readonly message: string;
  readonly timestamp: number;
  readonly username: Option.Option<string>;
  /** Whether the workspace holds this commit. */
  readonly isCurrent: boolean;
}

export const commitTreeItem = (commit: CommitHistoryItem) => {
  const label = commit.message || `Commit ${commit.id.substring(0, 8)}`;
  const item = new vscode.TreeItem(commit.isCurrent ? `✓ ${label}` : label);
  item.id = commit.id;
  item.description = DateTime.formatLocal(DateTime.makeUnsafe(commit.timestamp));
  item.tooltip = `${Option.getOrElse(commit.username, () => "Unknown user")} • ${commit.id}${commit.isCurrent ? " (currently loaded)" : ""}`;
  item.contextValue = "commit";
  item.iconPath = new vscode.ThemeIcon(commit.isCurrent ? "circle-filled" : "git-commit");
  item.command = {
    command: SERVER_SYNC_VIEW_COMMIT,
    title: "View Commit",
    arguments: [commit.id],
  };
  return item;
};

/** One playground in the chain of forks that leads to the one the workspace holds. */
export interface ForkHistoryItem {
  readonly hash: string;
  readonly name: string;
  readonly owner: Option.Option<string>;
  /** Whether the workspace holds this playground. */
  readonly isCurrent: boolean;
}

export const forkTreeItem = (fork: ForkHistoryItem) => {
  const label = fork.name || fork.hash.substring(0, 8);
  const item = new vscode.TreeItem(fork.isCurrent ? `✓ ${label}` : label);
  item.id = fork.hash;
  item.description = Option.match(fork.owner, {
    onNone: () => "anonymous",
    onSome: (owner) => `by ${owner}`,
  });
  item.tooltip = `${fork.hash}${fork.isCurrent ? " (current)" : ""}`;
  item.contextValue = "fork";
  item.iconPath = new vscode.ThemeIcon(fork.isCurrent ? "circle-filled" : "repo-forked");
  if (!fork.isCurrent) {
    item.command = {
      command: SERVER_SYNC_VIEW_FORK_SOURCE,
      title: "Open Fork Source",
      arguments: [fork.hash],
    };
  }
  return item;
};
