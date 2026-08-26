import { createSignal, Show } from "solid-js";
import { apiRequest } from "../api";
import { runRequest } from "../../../webview/request";

export const ForgotPasswordView = (props: { onNavigate: (view: string) => void }) => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sent, setSent] = createSignal(false);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const getText = (name: string) => {
      const value = data.get(name);
      return value instanceof File ? "" : (value ?? "");
    };
    setError(null);
    setSubmitting(true);

    void runRequest(
      apiRequest(
        "/api/forgotPassword",
        "POST",
        { email: getText("email") },
        { action: "auth.forgot_password.submit" },
      ),
    )
      .then(
        () => setSent(true),
        (reason: Error) => setError(reason.message),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <Show
      when={!sent()}
      fallback={
        <div class="auth-view" data-pw="forgot-password-sent">
          <div class="auth-header">
            <h2>Check Your Email</h2>
            <p class="auth-subtitle">
              If an account exists with that email, we've sent password reset instructions.
            </p>
          </div>

          <div class="auth-links">
            <button
              class="auth-link"
              onClick={() => {
                setSent(false);
                props.onNavigate("login");
              }}
            >
              Back to sign in
            </button>
          </div>
        </div>
      }
    >
      <div class="auth-view">
        <div class="auth-header">
          <h2>Forgot Password</h2>
          <p class="auth-subtitle">
            Enter your email and we'll send you a link to reset your password.
          </p>
        </div>

        <form onSubmit={handleSubmit} data-pw="forgot-password-form">
          <div class="auth-field">
            <label>Email</label>
            <input
              type="email"
              name="email"
              class="setting-input"
              placeholder="you@example.com"
              autofocus
              data-pw="forgot-email-input"
            />
          </div>

          <Show when={error()}>
            {(message) => (
              <div class="auth-error" data-pw="forgot-password-error">
                <i class="codicon codicon-error" />
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <button
            class="button auth-button-primary"
            type="submit"
            disabled={submitting()}
            data-pw="forgot-submit-button"
          >
            {submitting() ? "Sending..." : "Send Reset Link"}
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
