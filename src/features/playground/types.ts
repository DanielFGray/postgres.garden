/**
 * The playground webviews' message protocols.
 */

import * as S from "effect/Schema";
import { RelayRequest } from "../webview/relayProtocol";

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
