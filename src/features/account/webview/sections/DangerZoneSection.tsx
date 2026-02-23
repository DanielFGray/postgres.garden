import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const usernameAtom = Atom.make(
  apiRequest<{ user: { username: string } | null }>("/api/me", "GET", undefined, {
    action: "account.danger.load",
  }).pipe(
    Effect.flatMap((data) =>
      data.user
        ? Effect.succeed(data.user.username)
        : Effect.fail(new Error("Unauthorized")),
    ),
  ),
);

const showConfirmAtom = Atom.make(false);
const confirmInputAtom = Atom.make("");
const requestingAtom = Atom.make(false);
const requestedAtom = Atom.make(false);
const mutationErrorAtom = Atom.make<string | null>(null);

export const DangerZoneSection = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(usernameAtom);
    const showConfirm = yield* Atom.get(showConfirmAtom);
    const confirmInput = yield* Atom.get(confirmInputAtom);
    const requesting = yield* Atom.get(requestingAtom);
    const requested = yield* Atom.get(requestedAtom);
    const mutationError = yield* Atom.get(mutationErrorAtom);

    function handleDeleteRequest(username: string) {
      if (confirmInput !== username) return;

      registry.set(requestingAtom, true);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest<{ success: boolean }>("/api/me", "DELETE", undefined, {
          action: "account.danger.request_delete",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(requestedAtom, true);
              registry.set(showConfirmAtom, false);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(requestingAtom, false);
            }),
          ),
        ),
      );
    }

    function handleCancel() {
      registry.set(showConfirmAtom, false);
      registry.set(confirmInputAtom, "");
      registry.set(mutationErrorAtom, null);
    }

    return Result.builder(result)
      .onInitial(() => <div class="section-loading">Loading...</div>)
      .onError((error) => (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(usernameAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess((username) => (
        <div class="danger-zone-section">
          <div class="section-header">
            <h2>Danger Zone</h2>
          </div>

          <div
            class="danger-zone-container"
            style={{
              border: "1px solid var(--vscode-inputValidation-errorBorder)",
              borderRadius: "2px",
              padding: "16px",
            }}
          >
            <p style={{ margin: "0 0 8px", fontWeight: 500 }}>Delete Account</p>
            <p
              style={{
                margin: "0 0 16px",
                color: "var(--vscode-descriptionForeground)",
                fontSize: "12px",
              }}
            >
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>

            <ul
              style={{
                margin: "0 0 16px",
                paddingLeft: "20px",
                fontSize: "12px",
                color: "var(--vscode-descriptionForeground)",
              }}
            >
              <li>All playgrounds</li>
              <li>All comments</li>
              <li>All stars</li>
              <li>All email addresses</li>
              <li>All linked accounts</li>
            </ul>

            {requested ? (
              <p style={{ margin: 0, color: "var(--vscode-charts-green)" }}>
                <i class="codicon codicon-mail" style={{ marginRight: "6px" }} />A confirmation email
                has been sent to your primary email address. Click the link in the email to complete
                the deletion.
              </p>
            ) : !showConfirm ? (
              <button
                style={{
                  background: "var(--vscode-inputValidation-errorBorder)",
                  color: "#fff",
                  border: "none",
                  padding: "6px 12px",
                  cursor: "pointer",
                  borderRadius: "2px",
                  fontFamily: "var(--vscode-font-family)",
                  fontSize: "var(--vscode-font-size)",
                }}
                onClick={() => {
                  registry.set(showConfirmAtom, true);
                }}
              >
                Delete Account
              </button>
            ) : (
              <div
                style={{
                  background: "var(--vscode-inputValidation-errorBackground)",
                  border: "1px solid var(--vscode-inputValidation-errorBorder)",
                  borderRadius: "2px",
                  padding: "12px",
                }}
              >
                <p style={{ margin: "0 0 12px", fontWeight: 500 }}>
                  <i class="codicon codicon-warning" style={{ marginRight: "6px" }} />
                  This action is irreversible. All your data will be permanently deleted.
                </p>

                {mutationError && (
                  <div class="section-error" style={{ marginBottom: "12px" }}>
                    <i class="codicon codicon-error" />
                    <span>{mutationError}</span>
                  </div>
                )}

                <div class="field" style={{ marginBottom: "12px" }}>
                  <label>Type your username to confirm</label>
                  <input
                    type="text"
                    class="setting-input"
                    placeholder={username}
                    value={confirmInput}
                    onInput={(e: Event) => {
                      registry.set(confirmInputAtom, (e.target as HTMLInputElement).value);
                    }}
                    disabled={requesting}
                  />
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    style={{
                      background: "var(--vscode-inputValidation-errorBorder)",
                      color: "#fff",
                      border: "none",
                      padding: "6px 12px",
                      cursor: confirmInput === username ? "pointer" : "not-allowed",
                      borderRadius: "2px",
                      fontFamily: "var(--vscode-font-family)",
                      fontSize: "var(--vscode-font-size)",
                      opacity: confirmInput === username && !requesting ? 1 : 0.5,
                    }}
                    disabled={confirmInput !== username || requesting}
                    onClick={() => handleDeleteRequest(username)}
                  >
                    {requesting ? "Requesting..." : "I understand, delete my account"}
                  </button>
                  <button class="button" onClick={handleCancel} disabled={requesting}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))
      .render();
  });
