import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const passwordStatusAtom = Atom.make(
  apiRequest<{ has_password: boolean }>("/api/me/has-password", "GET", undefined, {
    action: "account.security.load_password_status",
  }),
);

const savingAtom = Atom.make(false);
const mutationErrorAtom = Atom.make<string | null>(null);
const successAtom = Atom.make<string | null>(null);

export const SecuritySection = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(passwordStatusAtom);
    const saving = yield* Atom.get(savingAtom);
    const mutationError = yield* Atom.get(mutationErrorAtom);
    const success = yield* Atom.get(successAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      const newPassword = data.get("newPassword") as string;
      const confirmPassword = data.get("confirmPassword") as string;

      registry.set(mutationErrorAtom, null);
      registry.set(successAtom, null);

      if (newPassword.length < 8) {
        registry.set(mutationErrorAtom, "New password must be at least 8 characters");
        return;
      }
      if (newPassword !== confirmPassword) {
        registry.set(mutationErrorAtom, "Passwords do not match");
        return;
      }

      const hasPassword = Result.isSuccess(result) ? result.value.has_password : false;
      registry.set(savingAtom, true);
      void Effect.runFork(
        apiRequest("/api/changePassword", "POST", {
          oldPassword: hasPassword ? (data.get("oldPassword") as string) : "",
          newPassword,
        }, {
          action: "account.security.change_password",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(
                successAtom,
                hasPassword ? "Password changed successfully" : "Password set successfully",
              );
              registry.refresh(passwordStatusAtom);
              form.reset();
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(savingAtom, false);
            }),
          ),
        ),
      );
    }

    return Result.builder(result)
      .onInitial(() => <div class="section-loading">Loading security settings...</div>)
      .onError((error) => (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(passwordStatusAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess(({ has_password: hasPassword }) => (
        <div class="security-section">
          <div class="section-header">
            <h2>{hasPassword ? "Change Password" : "Set Password"}</h2>
          </div>

          {!hasPassword && (
            <p
              style={{
                color: "var(--vscode-descriptionForeground)",
                fontStyle: "italic",
                margin: "0 0 12px",
              }}
            >
              You signed up with GitHub. Set a password to also log in with email.
            </p>
          )}

          <form onSubmit={handleSubmit}>
            {hasPassword && (
              <div class="field">
                <label>Current Password</label>
                <input type="password" name="oldPassword" class="setting-input" />
              </div>
            )}

            <div class="field">
              <label>New Password</label>
              <input type="password" name="newPassword" class="setting-input" />
            </div>

            <div class="field">
              <label>Confirm New Password</label>
              <input type="password" name="confirmPassword" class="setting-input" />
            </div>

            {mutationError && (
              <div class="section-error" style={{ margin: "8px 0" }}>
                <i class="codicon codicon-error" />
                <span>{mutationError}</span>
              </div>
            )}

            {success && (
              <div style={{ color: "var(--vscode-charts-green)", margin: "8px 0" }}>
                <i class="codicon codicon-check" /> {success}
              </div>
            )}

            <button class="button" type="submit" disabled={saving}>
              {saving ? "Saving..." : hasPassword ? "Change Password" : "Set Password"}
            </button>
          </form>
        </div>
      ))
      .render();
  });
