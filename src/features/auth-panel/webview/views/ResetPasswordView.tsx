import { createSignal, Show } from "solid-js";
import { apiCall } from "../api";
import * as Effect from "effect/Effect";
import { runRequest } from "../../../webview/request";

// Set by the host's `init-view` message before this view mounts. A signal, not
// a plain variable: the view renders once, so a plain write after mount would
// never reach the DOM.
const [resetToken, setResetToken] = createSignal("");

export { setResetToken };

export const ResetPasswordView = (props: { onNavigate: (view: string) => void }) => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  function handleSubmit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const getText = (name: string) => {
      const value = data.get(name);
      return value instanceof File ? "" : (value ?? "");
    };
    const password = getText("password");
    const confirmPassword = getText("confirmPassword");

    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);

    void runRequest(
      apiCall("auth.reset_password.submit", (api) =>
        api.apiUsers.resetPassword({
          payload: {
            token: getText("token"),
            password,
          },
        }),
      ).pipe(
        Effect.match({
          onFailure: (error) => setError(error.message),
          onSuccess: () => setSuccess(true),
        }),
        Effect.ensuring(Effect.sync(() => setSubmitting(false))),
      ),
    );
  }

  return (
    <Show
      when={!success()}
      fallback={
        <div class="auth-view" data-pw="password-reset-success">
          <div class="auth-header">
            <h2>Password Reset</h2>
            <p class="auth-subtitle">Your password has been reset successfully.</p>
          </div>

          <button
            class="button auth-button-primary"
            onClick={() => {
              setSuccess(false);
              props.onNavigate("login");
            }}
          >
            Sign In
          </button>
        </div>
      }
    >
      <div class="auth-view">
        <div class="auth-header">
          <h2>Reset Password</h2>
          <p class="auth-subtitle">Enter your new password.</p>
        </div>

        <form onSubmit={handleSubmit} data-pw="reset-password-form">
          <Show
            when={resetToken()}
            fallback={
              <div class="auth-field">
                <label>Reset Token</label>
                <input type="text" name="token" class="setting-input" data-pw="reset-token-input" />
              </div>
            }
          >
            <input type="hidden" name="token" value={resetToken()} />
          </Show>

          <div class="auth-field">
            <label>New Password</label>
            <input
              type="password"
              name="password"
              class="setting-input"
              placeholder="At least 8 characters"
              autofocus={!!resetToken()}
              data-pw="reset-password-input"
            />
          </div>

          <div class="auth-field">
            <label>Confirm New Password</label>
            <input
              type="password"
              name="confirmPassword"
              class="setting-input"
              data-pw="reset-confirm-password-input"
            />
          </div>

          <Show when={error()}>
            {(message) => (
              <div class="auth-error" data-pw="reset-password-error">
                <i class="codicon codicon-error" />
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <button
            class="button auth-button-primary"
            type="submit"
            disabled={submitting()}
            data-pw="reset-submit-button"
          >
            {submitting() ? "Resetting..." : "Reset Password"}
          </button>
        </form>

        <div class="auth-links">
          <button class="auth-link" onClick={() => props.onNavigate("login")}>
            Back to sign in
          </button>
        </div>
      </div>
    </Show>
  );
};
