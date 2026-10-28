import * as Effect from "effect/Effect";
import { createWebviewApiClient, vsCodeChannel } from "../../webview/relayTransport";
import { AuthComplete, AuthWebviewMessage, GitHubSignIn, Initialized } from "../types";

const client = createWebviewApiClient({
  feature: "auth-panel-webview",
  messages: AuthWebviewMessage,
  channel: vsCodeChannel(),
});

/** Makes one call against `PgGardenApi`, relayed by the extension host. */
export const apiCall = client.apiCall;

const post = (message: typeof AuthWebviewMessage.Type) =>
  void Effect.runFork(client.postMessage(message).pipe(Effect.tapCause(Effect.logError)));

export function signInWithGitHub() {
  post(new GitHubSignIn({ type: "github-signin" }));
}

export function notifyAuthComplete(username: string) {
  post(new AuthComplete({ type: "auth-complete", username }));
}

export function sendInitialized() {
  post(new Initialized({ type: "initialized" }));
}
