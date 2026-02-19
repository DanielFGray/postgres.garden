import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const usernameAtom = Atom.make<string | null>(null);
const showConfirmAtom = Atom.make(false);
const confirmInputAtom = Atom.make("");
const requestingAtom = Atom.make(false);
const requestedAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const loadingAtom = Atom.make(true);

function loadUsername(registry: AtomRegistry.Registry) {
  registry.set(loadingAtom, true);
  registry.set(errorAtom, null);
  apiRequest<{ user: { username: string } }>("/api/me")
    .then((data) => {
      registry.set(usernameAtom, data.user.username);
    })
    .catch((err: unknown) => {
      registry.set(errorAtom, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      registry.set(loadingAtom, false);
    });
}

let initialized = false;

export const DangerZoneSection = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;
      loadUsername(registry);
    }

    const username = yield* Atom.get(usernameAtom);
    const showConfirm = yield* Atom.get(showConfirmAtom);
    const confirmInput = yield* Atom.get(confirmInputAtom);
    const requesting = yield* Atom.get(requestingAtom);
    const requested = yield* Atom.get(requestedAtom);
    const error = yield* Atom.get(errorAtom);
    const loading = yield* Atom.get(loadingAtom);

    function handleDeleteRequest() {
      const un = registry.get(usernameAtom);
      const ci = registry.get(confirmInputAtom);
      if (!un || ci !== un) return;

      registry.set(requestingAtom, true);
      registry.set(errorAtom, null);
      apiRequest<{ success: boolean }>("/api/me", "DELETE")
        .then(() => {
          registry.set(requestedAtom, true);
          registry.set(showConfirmAtom, false);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(requestingAtom, false);
        });
    }

    function handleCancel() {
      registry.set(showConfirmAtom, false);
      registry.set(confirmInputAtom, "");
      registry.set(errorAtom, null);
    }

    if (loading) {
      return <div class="section-loading">Loading...</div>;
    }

    if (error && !username) {
      return (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error}</span>
          <button class="button" onClick={() => loadUsername(registry)}>Retry</button>
        </div>
      );
    }

    return (
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
          <p style={{ margin: "0 0 8px", fontWeight: 500 }}>
            Delete Account
          </p>
          <p style={{ margin: "0 0 16px", color: "var(--vscode-descriptionForeground)", fontSize: "12px" }}>
            Permanently delete your account and all associated data. This action cannot be undone.
          </p>

          <ul style={{ margin: "0 0 16px", paddingLeft: "20px", fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>
            <li>All playgrounds</li>
            <li>All comments</li>
            <li>All stars</li>
            <li>All email addresses</li>
            <li>All linked accounts</li>
          </ul>

          {requested ? (
            <p style={{ margin: 0, color: "var(--vscode-charts-green)" }}>
              <i class="codicon codicon-mail" style={{ marginRight: "6px" }} />
              A confirmation email has been sent to your primary email address. Click the link in the email to complete the deletion.
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
              onClick={() => { registry.set(showConfirmAtom, true); }}
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

              {error && (
                <div class="section-error" style={{ marginBottom: "12px" }}>
                  <i class="codicon codicon-error" />
                  <span>{error}</span>
                </div>
              )}

              <div class="field" style={{ marginBottom: "12px" }}>
                <label>Type your username to confirm</label>
                <input
                  type="text"
                  class="setting-input"
                  placeholder={username ?? ""}
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
                  onClick={handleDeleteRequest}
                >
                  {requesting ? "Requesting..." : "I understand, delete my account"}
                </button>
                <button
                  class="button"
                  onClick={handleCancel}
                  disabled={requesting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  });
