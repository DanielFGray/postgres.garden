import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const userIdAtom = Atom.make("");
const tokenAtom = Atom.make("");
const passwordAtom = Atom.make("");
const confirmPasswordAtom = Atom.make("");
const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const successAtom = Atom.make(false);

export function setResetParams(userId: string, token: string) {
  // These will be picked up on next render
  _pendingUserId = userId;
  _pendingToken = token;
}

let _pendingUserId = "";
let _pendingToken = "";
let _paramsApplied = false;

export const ResetPasswordView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    // Apply URL params if available
    if (!_paramsApplied && (_pendingUserId || _pendingToken)) {
      registry.set(userIdAtom, _pendingUserId);
      registry.set(tokenAtom, _pendingToken);
      _paramsApplied = true;
    }

    const userId = yield* Atom.get(userIdAtom);
    const token = yield* Atom.get(tokenAtom);
    const password = yield* Atom.get(passwordAtom);
    const confirmPassword = yield* Atom.get(confirmPasswordAtom);
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);
    const success = yield* Atom.get(successAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      registry.set(errorAtom, null);

      const pw = registry.get(passwordAtom);
      const cpw = registry.get(confirmPasswordAtom);

      if (pw.length < 8) {
        registry.set(errorAtom, "Password must be at least 8 characters");
        return;
      }
      if (pw !== cpw) {
        registry.set(errorAtom, "Passwords do not match");
        return;
      }

      registry.set(submittingAtom, true);

      void apiRequest("/api/resetPassword", "POST", {
        userId: registry.get(userIdAtom),
        token: registry.get(tokenAtom),
        password: pw,
      })
        .then(() => {
          registry.set(successAtom, true);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(submittingAtom, false);
        });
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
              registry.set(passwordAtom, "");
              registry.set(confirmPasswordAtom, "");
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
          {!_pendingUserId && (
            <>
              <div class="auth-field">
                <label>User ID</label>
                <input
                  type="text"
                  class="setting-input"
                  value={userId}
                  onInput={(e: Event) => {
                    registry.set(userIdAtom, (e.target as HTMLInputElement).value);
                  }}
                />
              </div>

              <div class="auth-field">
                <label>Reset Token</label>
                <input
                  type="text"
                  class="setting-input"
                  value={token}
                  onInput={(e: Event) => {
                    registry.set(tokenAtom, (e.target as HTMLInputElement).value);
                  }}
                />
              </div>
            </>
          )}

          <div class="auth-field">
            <label>New Password</label>
            <input
              type="password"
              class="setting-input"
              placeholder="At least 8 characters"
              value={password}
              onInput={(e: Event) => {
                registry.set(passwordAtom, (e.target as HTMLInputElement).value);
              }}
              autoFocus={!!_pendingUserId}
            />
          </div>

          <div class="auth-field">
            <label>Confirm New Password</label>
            <input
              type="password"
              class="setting-input"
              value={confirmPassword}
              onInput={(e: Event) => {
                registry.set(confirmPasswordAtom, (e.target as HTMLInputElement).value);
              }}
            />
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
