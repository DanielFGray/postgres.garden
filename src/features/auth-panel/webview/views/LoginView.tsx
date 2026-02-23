import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest, signInWithGitHub, notifyAuthComplete } from "../api";

const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);

interface LoginResponse {
  id: string;
  username: string;
}

export const LoginView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      registry.set(errorAtom, null);
      registry.set(submittingAtom, true);

      void Effect.runFork(
        apiRequest<LoginResponse>("/login", "POST", {
          id: data.get("id"),
          password: data.get("password"),
        }, {
          action: "auth.login.submit",
        }).pipe(
          Effect.tap((resp) => Effect.sync(() => notifyAuthComplete(resp.username))),
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

    return (
      <div class="auth-view">
        <div class="auth-header">
          <h2>Sign In</h2>
          <p class="auth-subtitle">Sign in to your postgres.garden account</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="auth-field">
            <label>Email or Username</label>
            <input
              type="text"
              name="id"
              class="setting-input"
              placeholder="you@example.com"
              autoFocus
            />
          </div>

          <div class="auth-field">
            <label>Password</label>
            <input type="password" name="password" class="setting-input" />
          </div>

          {error && (
            <div class="auth-error">
              <i class="codicon codicon-error" />
              <span>{error}</span>
            </div>
          )}

          <button class="button auth-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div class="auth-links">
          <button class="auth-link" onClick={() => props.onNavigate("forgot-password")}>
            Forgot password?
          </button>
          <span class="auth-link-separator">·</span>
          <button class="auth-link" onClick={() => props.onNavigate("register")}>
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
  });
