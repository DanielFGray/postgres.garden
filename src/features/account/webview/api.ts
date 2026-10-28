import { Effect, Option } from "effect";
import { ApiRequestError } from "../../../httpapi-client";
import { createWebviewApiClient, vsCodeChannel } from "../../webview/relayTransport";
import { AccountDeleted, AccountWebviewMessage, Initialized } from "../types";

const client = createWebviewApiClient({
  feature: "account-settings-webview",
  messages: AccountWebviewMessage,
  channel: vsCodeChannel(),
});

/** Makes one call against `PgGardenApi`, relayed by the extension host. */
export const apiCall = client.apiCall;

/** The signed-in visitor's profile; a visitor with no session fails as 401. */
export const loadProfile = (action: string) =>
  apiCall(action, (api) => api.apiUsers.me({})).pipe(
    Effect.flatMap(({ user }) =>
      Effect.fromOption(
        Option.fromNullOr(user),
        () => new ApiRequestError({ status: 401, message: "Not signed in" }),
      ),
    ),
  );

const post = (message: Initialized | AccountDeleted) =>
  client.postMessage(message).pipe(Effect.catchCause(Effect.logError));

export function sendInitialized() {
  Effect.runFork(post(new Initialized({ type: "initialized" })));
}

export function notifyAccountDeleted() {
  Effect.runFork(post(new AccountDeleted({ type: "account-deleted" })));
}
