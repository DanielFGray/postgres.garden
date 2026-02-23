import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const successAtom = Atom.make(false);

let _pendingUserId = "";
let _pendingToken = "";

export function setResetParams(userId: string, token: string) {
  _pendingUserId = userId;
  _pendingToken = token;
}

export const ResetPasswordView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);
    const success = yield* Atom.get(successAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      const password = data.get("password") as string;
      const confirmPassword = data.get("confirmPassword") as string;

      registry.set(errorAtom, null);

      if (password.length < 8) {
        registry.set(errorAtom, "Password must be at least 8 characters");
        return;
      }
      if (password !== confirmPassword) {
        registry.set(errorAtom, "Passwords do not match");
        return;
      }

      registry.set(submittingAtom, true);

      void Effect.runFork(
        apiRequest("/api/resetPassword", "POST", {
          userId: data.get("userId"),
          token: data.get("token"),
          password,
        }, {
          action: "auth.reset_password.submit",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              registry.set(successAtom, true);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(errorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(submittingAtom, false);
            }),
          ),
        ),
      );
    }

    if (success) {
      return (
        <div class="auth-view">
          <div class="auth-header">
            <h2>Password Reset</h2>
            <p class="auth-subtitle">Your password has been reset successfully.</p>
          </div>

          <button
            class="button auth-button-primary"
            onClick={() => {
              registry.set(successAtom, false);
              props.onNavigate("login");
            }}
          >
            Sign In
          </button>
        </div>
      );
    }

    return (
      <div class="auth-view">
        <div class="auth-header">
          <h2>Reset Password</h2>
          <p class="auth-subtitle">Enter your new password.</p>
        </div>

        <form onSubmit={handleSubmit}>
          {_pendingUserId ? (
            <>
              <input type="hidden" name="userId" value={_pendingUserId} />
              <input type="hidden" name="token" value={_pendingToken} />
            </>
          ) : (
            <>
              <div class="auth-field">
                <label>User ID</label>
                <input type="text" name="userId" class="setting-input" />
              </div>

              <div class="auth-field">
                <label>Reset Token</label>
                <input type="text" name="token" class="setting-input" />
              </div>
            </>
          )}

          <div class="auth-field">
            <label>New Password</label>
            <input
              type="password"
              name="password"
              class="setting-input"
              placeholder="At least 8 characters"
              autoFocus={!!_pendingUserId}
            />
          </div>

          <div class="auth-field">
            <label>Confirm New Password</label>
            <input type="password" name="confirmPassword" class="setting-input" />
          </div>

          {error && (
            <div class="auth-error">
              <i class="codicon codicon-error" />
              <span>{error}</span>
            </div>
          )}

          <button class="button auth-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Resetting..." : "Reset Password"}
          </button>
        </form>

        <div class="auth-links">
          <button class="auth-link" onClick={() => props.onNavigate("login")}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  });
