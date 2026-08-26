import { createSignal, Show } from "solid-js";
import { apiRequest, signInWithGitHub, notifyAuthComplete } from "../api";
import { runRequest } from "../../../webview/request";

interface RegisterResponse {
  id: string;
  username: string;
}

export const RegisterView = (props: { onNavigate: (view: string) => void }) => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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
      apiRequest<RegisterResponse>(
        "/register",
        "POST",
        { username: getText("username"), email: getText("email"), password },
        { action: "auth.register.submit" },
      ),
    )
      .then(
        (resp) => notifyAuthComplete(resp.username),
        (reason: Error) => setError(reason.message),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <div class="auth-view">
      <div class="auth-header">
        <h2>Create Account</h2>
        <p class="auth-subtitle">Join postgres.garden</p>
      </div>

      <form onSubmit={handleSubmit} data-pw="register-form">
        <div class="auth-field">
          <label>Username</label>
          <input
            type="text"
            name="username"
            class="setting-input"
            placeholder="Choose a username"
            autofocus
            data-pw="register-username-input"
          />
        </div>

        <div class="auth-field">
          <label>Email</label>
          <input
            type="email"
            name="email"
            class="setting-input"
            placeholder="you@example.com"
            data-pw="register-email-input"
          />
        </div>

        <div class="auth-field">
          <label>Password</label>
          <input
            type="password"
            name="password"
            class="setting-input"
            placeholder="At least 8 characters"
            data-pw="register-password-input"
          />
        </div>

        <div class="auth-field">
          <label>Confirm Password</label>
          <input
            type="password"
            name="confirmPassword"
            class="setting-input"
            data-pw="register-confirm-password-input"
          />
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="auth-error" data-pw="register-error">
              <i class="codicon codicon-error" />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <button
          class="button auth-button-primary"
          type="submit"
          disabled={submitting()}
          data-pw="register-submit-button"
        >
          {submitting() ? "Creating account..." : "Create Account"}
        </button>
      </form>

      <div class="auth-links">
        <button class="auth-link" onClick={() => props.onNavigate("login")} data-pw="nav-login">
          Already have an account? Sign in
        </button>
      </div>

      <div class="auth-divider">
        <span>or</span>
      </div>

      <button class="button auth-button-github" onClick={signInWithGitHub} type="button">
        <i class="codicon codicon-github" />
        Sign up with GitHub
      </button>
    </div>
  );
};
