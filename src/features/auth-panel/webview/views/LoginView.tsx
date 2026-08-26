import { createSignal, Show } from "solid-js";
import { apiRequest, notifyAuthComplete, signInWithGitHub } from "../api";
import { runRequest } from "../../../webview/request";
import { extractErrorMessage } from "../../../webview/errorMessage";

const readFormString = (value: FormDataEntryValue | null): string =>
  typeof value === "string" ? value : "";

export const LoginView = (props: { onNavigate: (view: string) => void }) => {
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    setError(null);
    setSubmitting(true);
    void runRequest(
      apiRequest<{ username: string }>(
        "/login",
        "POST",
        {
          id: readFormString(data.get("id")),
          password: readFormString(data.get("password")),
        },
        { action: "auth.login.submit" },
      ),
    )
      .then(
        (user) => notifyAuthComplete(user.username),
        (reason) => setError(extractErrorMessage(reason)),
      )
      .finally(() => setSubmitting(false));
  }

  return (
    <div class="auth-view">
      <div class="auth-header">
        <h2>Sign In</h2>
        <p class="auth-subtitle">Sign in to your postgres.garden account</p>
      </div>

      <form onSubmit={handleSubmit} data-pw="login-form">
        <div class="auth-field">
          <label>Email or Username</label>
          <input
            type="text"
            name="id"
            class="setting-input"
            autofocus
            placeholder="you@example.com"
            data-pw="login-id-input"
          />
        </div>

        <div class="auth-field">
          <label>Password</label>
          <input
            type="password"
            name="password"
            class="setting-input"
            data-pw="login-password-input"
          />
        </div>

        <Show when={error()}>
          {(message) => (
            <div class="auth-error" data-pw="login-error">
              <i class="codicon codicon-error" />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <button
          class="button auth-button-primary"
          type="submit"
          disabled={submitting()}
          data-pw="login-submit-button"
        >
          {submitting() ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <div class="auth-links">
        <button
          class="auth-link"
          onClick={() => props.onNavigate("forgot-password")}
          data-pw="forgot-password-link"
        >
          Forgot password?
        </button>
        <span class="auth-link-separator">·</span>
        <button
          class="auth-link"
          onClick={() => props.onNavigate("register")}
          data-pw="nav-register"
        >
          Create an account
        </button>
      </div>

      <div class="auth-divider">
        <span>or</span>
      </div>

      <button class="button auth-button-github" onClick={signInWithGitHub} type="button">
        <i class="codicon codicon-github" />
        Sign in with GitHub
      </button>
    </div>
  );
};
