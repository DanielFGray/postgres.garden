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
  stars?: string;
  is_starred?: boolean;
}
