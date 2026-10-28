import { createSignal, refresh, Match, Show, Switch } from "solid-js";
import { Effect, Option } from "effect";
import { apiCall, loadProfile, notifyAccountDeleted } from "../api";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";

const loadUsername = () =>
  loadProfile("account.danger.load").pipe(Effect.map((profile) => profile.username));

const [deleteToken, setDeleteToken] = createSignal(Option.none<string>());

/** Sets the token from an emailed deletion link; with one, the section offers to finish the delete. */
export function initializeDangerZone(token: Option.Option<string>) {
  setDeleteToken(token);
}

const dangerButton = (enabled: boolean) => ({
  background: "var(--vscode-inputValidation-errorBorder)",
  color: "#fff",
  border: "none",
  padding: "6px 12px",
  cursor: enabled ? "pointer" : "not-allowed",
  "border-radius": "2px",
  "font-family": "var(--vscode-font-family)",
  "font-size": "var(--vscode-font-size)",
  opacity: enabled ? 1 : 0.5,
});

const mutedText = {
  margin: "0 0 12px",
  color: "var(--vscode-descriptionForeground)",
  "font-size": "12px",
};

export const DangerZoneSection = () => {
  const username = createRequest(loadUsername);
  const [showConfirm, setShowConfirm] = createSignal(false);
  const [confirmInput, setConfirmInput] = createSignal("");
  const [requesting, setRequesting] = createSignal(false);
  const [requested, setRequested] = createSignal(false);
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [deleted, setDeleted] = createSignal(false);

  const confirmed = () => confirmInput() === username();

  function handleDeleteRequest() {
    if (!confirmed()) return;

    setRequesting(true);
    setMutationError(null);
    void runRequest(
      // Without a token the server emails a link that carries one.
      apiCall("account.danger.request_delete", (api) => api.apiUsers.deleteMe({ query: {} })),
    )
      .then(
        () => {
          setRequested(true);
          setShowConfirm(false);
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setRequesting(false));
  }

  function handleCancel() {
    setShowConfirm(false);
    setConfirmInput("");
    setMutationError(null);
  }

  function handleDeleteConfirm(token: string) {
    setRequesting(true);
    setMutationError(null);
    void runRequest(
      apiCall("account.danger.confirm_delete", (api) =>
        api.apiUsers.deleteMe({ query: { token } }),
      ),
    )
      .then(
        (response) => {
          if (response.success) {
            setDeleted(true);
            notifyAccountDeleted();
          } else setMutationError("Account deletion confirmation failed");
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setRequesting(false));
  }

  const MutationError = () => (
    <Show when={mutationError()}>
      {(message) => (
        <div
          class="section-error"
          style={{ "margin-bottom": "12px" }}
          data-pw="account-delete-error"
        >
          <i class="codicon codicon-error" />
          <span>{message()}</span>
        </div>
      )}
    </Show>
  );

  return (
    <SectionBoundary loading="Loading..." retry={() => refresh(username)}>
      <div class="danger-zone-section" data-pw="danger-zone-section">
        <div class="section-header">
          <h2>Danger Zone</h2>
        </div>

        <div
          class="danger-zone-container"
          style={{
            border: "1px solid var(--vscode-inputValidation-errorBorder)",
            "border-radius": "2px",
            padding: "16px",
          }}
        >
          <p style={{ margin: "0 0 8px", "font-weight": 500 }}>Delete Account</p>
          <p style={{ ...mutedText, margin: "0 0 16px" }}>
            Permanently delete your account and all associated data. This action cannot be undone.
          </p>

          <ul
            style={{
              margin: "0 0 16px",
              "padding-left": "20px",
              "font-size": "12px",
              color: "var(--vscode-descriptionForeground)",
            }}
          >
            <li>All playgrounds</li>
            <li>All comments</li>
            <li>All stars</li>
            <li>All email addresses</li>
            <li>All linked accounts</li>
          </ul>

          <Switch>
            <Match when={deleted()}>
              <p
                style={{ margin: 0, color: "var(--vscode-charts-green)" }}
                data-pw="account-delete-complete"
              >
                <i class="codicon codicon-check" style={{ "margin-right": "6px" }} />
                Your account has been deleted.
              </p>
            </Match>

            <Match when={Option.getOrUndefined(deleteToken())}>
              {(token) => (
                <div data-pw="account-delete-token-confirm">
                  <p style={{ margin: "0 0 12px", "font-weight": 500 }}>
                    <i class="codicon codicon-warning" style={{ "margin-right": "6px" }} />
                    Confirm account deletion
                  </p>
                  <p style={mutedText}>
                    This email link will permanently delete your account and all associated data.
                  </p>
                  <MutationError />
                  <button
                    class="button"
                    disabled={requesting()}
                    onClick={() => handleDeleteConfirm(token())}
                    data-pw="account-delete-confirm-button"
                  >
                    {requesting() ? "Deleting..." : "Delete My Account"}
                  </button>
                </div>
              )}
            </Match>

            <Match when={requested()}>
              <p
                style={{ margin: 0, color: "var(--vscode-charts-green)" }}
                data-pw="account-delete-request-sent"
              >
                <i class="codicon codicon-mail" style={{ "margin-right": "6px" }} />
                A confirmation email has been sent to your primary email address. Click the link in
                the email to complete the deletion.
              </p>
            </Match>

            <Match when={!showConfirm()}>
              <button
                style={dangerButton(true)}
                onClick={() => setShowConfirm(true)}
                data-pw="account-delete-request-button"
              >
                Delete Account
              </button>
            </Match>

            <Match when={true}>
              <div
                style={{
                  background: "var(--vscode-inputValidation-errorBackground)",
                  border: "1px solid var(--vscode-inputValidation-errorBorder)",
                  "border-radius": "2px",
                  padding: "12px",
                }}
              >
                <p style={{ margin: "0 0 12px", "font-weight": 500 }}>
                  <i class="codicon codicon-warning" style={{ "margin-right": "6px" }} />
                  This action is irreversible. All your data will be permanently deleted.
                </p>

                <MutationError />

                <div class="field" style={{ "margin-bottom": "12px" }}>
                  <label>Type your username to confirm</label>
                  <input
                    type="text"
                    class="setting-input"
                    placeholder={username()}
                    value={confirmInput()}
                    onInput={(e) => setConfirmInput(e.currentTarget.value)}
                    disabled={requesting()}
                    data-pw="account-delete-confirm-input"
                  />
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    style={dangerButton(confirmed() && !requesting())}
                    disabled={!confirmed() || requesting()}
                    onClick={handleDeleteRequest}
                    data-pw="account-delete-request-confirm-button"
                  >
                    {requesting() ? "Requesting..." : "I understand, delete my account"}
                  </button>
                  <button class="button" onClick={handleCancel} disabled={requesting()}>
                    Cancel
                  </button>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </SectionBoundary>
  );
};
