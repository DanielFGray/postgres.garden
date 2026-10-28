/**
 * Playground feature types
 */

import * as S from "effect/Schema";
import { RelayRequest } from "../webview/relayProtocol";

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

// --- Webview messages ------------------------------------------------------
//
// What each playground webview sends its extension host. The host decodes the
// message once on arrival, so each union is the whole of that webview's
// protocol, server calls (`RelayRequest`) included.

/** A webview asks the workbench to open one playground. */
export class OpenPlaygroundMessage extends S.Class<
  OpenPlaygroundMessage,
  { readonly brand: unique symbol }
>("OpenPlaygroundMessage")({
  type: S.Literal("open-playground"),
  hash: S.String,
}) {}

/** The metadata panel's script has loaded and can take its first playground. */
export class PanelInitializedMessage extends S.Class<
  PanelInitializedMessage,
  { readonly brand: unique symbol }
>("PanelInitializedMessage")({
  type: S.Literal("initialized"),
}) {}

export const PlaygroundListMessage = S.Union([RelayRequest, OpenPlaygroundMessage]);

export const PlaygroundPanelMessage = S.Union([
  RelayRequest,
  PanelInitializedMessage,
  OpenPlaygroundMessage,
]);
