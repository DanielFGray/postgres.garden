import { createSignal, Show } from "solid-js";
import { apiRequest } from "../api";
import { runRequest } from "../../../webview/request";

// Set by the host's `init-view` message before this view mounts. Signals, not
// plain variables: the view renders once, so a plain write after mount would
// never reach the DOM.
const [resetParams, setParams] = createSignal({ userId: "", token: "" });

export function setResetParams(userId: string, token: string) {
  setParams({ userId, token });
}

export const ResetPasswordView = (props: { onNavigate: (view: string) => void }) => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
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
      apiRequest(
        "/api/resetPassword",
        "POST",
        { userId: getText("userId"), token: getText("token"), password },
        { action: "auth.reset_password.submit" },
      ),
    )
      .then(
        () => setSuccess(true),
        (reason: Error) => setError(reason.message),
      )
      .finally(() => setSubmitting(false));
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
            when={resetParams().userId}
            fallback={
              <>
                <div class="auth-field">
                  <label>User ID</label>
                  <input
                    type="text"
                    name="userId"
                    class="setting-input"
                    data-pw="reset-userid-input"
                  />
                </div>

                <div class="auth-field">
                  <label>Reset Token</label>
                  <input
                    type="text"
                    name="token"
                    class="setting-input"
                    data-pw="reset-token-input"
                  />
                </div>
              </>
            }
          >
            <input type="hidden" name="userId" value={resetParams().userId} />
            <input type="hidden" name="token" value={resetParams().token} />
          </Show>

          <div class="auth-field">
            <label>New Password</label>
            <input
              type="password"
              name="password"
              class="setting-input"
              placeholder="At least 8 characters"
              autofocus={!!resetParams().userId}
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
