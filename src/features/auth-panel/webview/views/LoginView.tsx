import { createSignal, Show } from "solid-js";
import { apiCall, notifyAuthComplete, signInWithGitHub } from "../api";
import * as Effect from "effect/Effect";
import { runRequest } from "../../../webview/request";

const readFormString = (value: FormDataEntryValue | null): string =>
  value instanceof File ? "" : (value ?? "");

export const LoginView = (props: { onNavigate: (view: string) => void }) => {
  const [error, setError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  function handleSubmit(e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    setSubmitting(true);
    void runRequest(
      apiCall("auth.login.submit", (api) =>
        api.auth.login({
          payload: {
            id: readFormString(data.get("id")),
            password: readFormString(data.get("password")),
          },
        }),
      ).pipe(
        Effect.match({
          onFailure: (error) => setError(error.message),
          onSuccess: (user) => notifyAuthComplete(user.username),
        }),
        Effect.ensuring(Effect.sync(() => setSubmitting(false))),
      ),
    );
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
