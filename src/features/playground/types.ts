/**
 * Playground feature types
 */

export type Privacy = "private" | "secret" | "public";

export interface Playground {
  hash: string;
  user_id: string | null;
  fork_hash?: string | null;
  privacy: Privacy;
  created_at: string;
  updated_at: string;
  name: string | null;
  description?: string | null;
  data_size?: number;
  expires_at?: string | null;
  // Note: File data is stored in playground_commits, not in the playground itself
}

export interface CreatePlaygroundRequest {
  name?: string;
  description?: string;
  privacy?: Privacy;
  // Note: Initial files should be created via a commit, not in the playground itself
}

export interface UpdatePlaygroundRequest {
  name?: string;
  description?: string;
  privacy?: Privacy;
  // Note: File data is stored in commits, not in playground
}

export interface PlaygroundListItem {
  hash: string;
  name: string | null;
  description?: string | null;
  privacy: Privacy;
  updated_at: string;
  fork_hash?: string | null;
  user_id?: string | null;
  expires_at?: string | null;
}

// Message types for webview communication
export type ExtensionToViewMessage =
  | { type: "playgroundsList"; data: PlaygroundListItem[] }
  | { type: "playgroundCreated" }
  | { type: "playgroundDeleted" }
  | { type: "error"; data: { message: string } };

export type ViewToExtensionMessage =
  | { type: "loadPlaygrounds" }
  | { type: "createPlayground"; data: { name: string } }
  | { type: "openPlayground"; data: { hash: string } }
  | { type: "deletePlayground"; data: { hash: string } }
  | { type: "forkPlayground"; data: { hash: string } };

export type ExtensionToPanelMessage =
  | { type: "loadPlayground"; data: Playground }
  | { type: "saved"; data: { timestamp: string } }
  | { type: "error"; data: { message: string } };

export type PanelToExtensionMessage =
  | { type: "updateMetadata"; data: { name?: string; description?: string; privacy?: string } }
  | { type: "fork" }
  | { type: "initialized" };
