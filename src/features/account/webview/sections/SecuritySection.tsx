import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const hasPasswordAtom = Atom.make<boolean | null>(null);
const oldPasswordAtom = Atom.make("");
const newPasswordAtom = Atom.make("");
const confirmPasswordAtom = Atom.make("");
const savingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const successAtom = Atom.make<string | null>(null);
const loadingAtom = Atom.make(true);

function loadPasswordStatus(registry: AtomRegistry.Registry) {
  registry.set(loadingAtom, true);
  registry.set(errorAtom, null);
  apiRequest<{ has_password: boolean }>("/api/me/has-password")
    .then((data) => {
      registry.set(hasPasswordAtom, data.has_password);
    })
    .catch((err: unknown) => {
      registry.set(errorAtom, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      registry.set(loadingAtom, false);
    });
}

let initialized = false;

export const SecuritySection = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;
      loadPasswordStatus(registry);
    }

    const hasPassword = yield* Atom.get(hasPasswordAtom);
    const oldPassword = yield* Atom.get(oldPasswordAtom);
    const newPassword = yield* Atom.get(newPasswordAtom);
    const confirmPassword = yield* Atom.get(confirmPasswordAtom);
    const saving = yield* Atom.get(savingAtom);
    const error = yield* Atom.get(errorAtom);
    const success = yield* Atom.get(successAtom);
    const loading = yield* Atom.get(loadingAtom);

    function resetForm() {
      registry.set(oldPasswordAtom, "");
      registry.set(newPasswordAtom, "");
      registry.set(confirmPasswordAtom, "");
      registry.set(errorAtom, null);
      registry.set(successAtom, null);
    }

    function validate(): string | null {
      const np = registry.get(newPasswordAtom);
      const cp = registry.get(confirmPasswordAtom);
      if (np.length < 8) {
        return "New password must be at least 8 characters";
      }
      if (np !== cp) {
        return "Passwords do not match";
      }
      return null;
    }

    function handleSubmit(e: Event) {
      e.preventDefault();
      registry.set(errorAtom, null);
      registry.set(successAtom, null);

      const validationError = validate();
      if (validationError) {
        registry.set(errorAtom, validationError);
        return;
      }

      registry.set(savingAtom, true);
      const hp = registry.get(hasPasswordAtom);
      void apiRequest("/api/changePassword", "POST", {
        oldPassword: hp ? registry.get(oldPasswordAtom) : "",
        newPassword: registry.get(newPasswordAtom),
      })
        .then(() => {
          registry.set(successAtom, hp
            ? "Password changed successfully"
            : "Password set successfully");
          registry.set(hasPasswordAtom, true);
          registry.set(oldPasswordAtom, "");
          registry.set(newPasswordAtom, "");
          registry.set(confirmPasswordAtom, "");
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(savingAtom, false);
        });
    }

    if (loading) {
      return <div class="section-loading">Loading security settings...</div>;
    }

    if (error && hasPassword === null) {
      return (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error}</span>
          <button class="button" onClick={() => { resetForm(); loadPasswordStatus(registry); }}>
            Retry
          </button>
        </div>
      );
    }

    return (
      <div class="security-section">
        <div class="section-header">
          <h2>{hasPassword ? "Change Password" : "Set Password"}</h2>
        </div>

        {!hasPassword && (
          <p style={{ color: "var(--vscode-descriptionForeground)", fontStyle: "italic", margin: "0 0 12px" }}>
            You signed up with GitHub. Set a password to also log in with email.
          </p>
        )}

        <form onSubmit={handleSubmit}>
          {hasPassword && (
            <div class="field">
              <label>Current Password</label>
              <input
                type="password"
                class="setting-input"
                value={oldPassword}
                onInput={(e: Event) => { registry.set(oldPasswordAtom, (e.target as HTMLInputElement).value); }}
              />
            </div>
          )}

          <div class="field">
            <label>New Password</label>
            <input
              type="password"
              class="setting-input"
              value={newPassword}
              onInput={(e: Event) => { registry.set(newPasswordAtom, (e.target as HTMLInputElement).value); }}
            />
          </div>

          <div class="field">
            <label>Confirm New Password</label>
            <input
              type="password"
              class="setting-input"
              value={confirmPassword}
              onInput={(e: Event) => { registry.set(confirmPasswordAtom, (e.target as HTMLInputElement).value); }}
            />
          </div>

          {error && (
            <div class="section-error" style={{ margin: "8px 0" }}>
              <i class="codicon codicon-error" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div style={{ color: "var(--vscode-charts-green)", margin: "8px 0" }}>
              <i class="codicon codicon-check" />
              {" "}{success}
            </div>
          )}

          <button class="button" type="submit" disabled={saving}>
            {saving
              ? "Saving..."
              : hasPassword
                ? "Change Password"
                : "Set Password"}
          </button>
        </form>
      </div>
    );
  });
