/**
 * Shared Effect Schemas for postgres.garden
 *
 * These define the data shapes that flow between server and client.
 * Used by both service implementations (Kysely on server, API on client).
 */

import * as S from "effect/Schema";

// =============================================================================
// User
// =============================================================================

export class User extends S.Class<User>("User")({
  id: S.String,
  username: S.String,
  role: S.optional(S.String),
}) {}

// =============================================================================
// Commit
// =============================================================================

export const FileEntry = S.Struct({
  path: S.String,
  content: S.String,
});

export class Commit extends S.Class<Commit>("Commit")({
  id: S.String,
  message: S.String,
  created_at: S.String,
  playground_hash: S.String,
  parent_id: S.NullOr(S.String),
  files: S.Array(FileEntry),
  activeFile: S.NullOr(S.String),
  timestamp: S.Number,
}) {}
