import { createWebviewApiClient, vsCodeChannel } from "../../../webview/relayTransport";
import { OpenPlaygroundMessage, PlaygroundListMessage } from "../../types";

const client = createWebviewApiClient({
  feature: "playground-list-webview",
  messages: PlaygroundListMessage,
  channel: vsCodeChannel(),
});

/** Makes one call against `PgGardenApi`, relayed by the extension host. */
export const apiCall = client.apiCall;

export const openPlayground = (hash: string) =>
  client.postMessage(new OpenPlaygroundMessage({ type: "open-playground", hash }));
