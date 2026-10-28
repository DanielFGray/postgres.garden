import { createWebviewApiClient, vsCodeChannel } from "../../../webview/relayTransport";
import {
  OpenPlaygroundMessage,
  PanelInitializedMessage,
  PlaygroundPanelMessage,
} from "../../types";

const client = createWebviewApiClient({
  feature: "playground-panel-webview",
  messages: PlaygroundPanelMessage,
  channel: vsCodeChannel(),
});

/** Makes one call against `PgGardenApi`, relayed by the extension host. */
export const apiCall = client.apiCall;

export const announceInitialized = client.postMessage(
  new PanelInitializedMessage({ type: "initialized" }),
);

export const openPlayground = (hash: string) =>
  client.postMessage(new OpenPlaygroundMessage({ type: "open-playground", hash }));
