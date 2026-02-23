import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest, signInWithGitHub, notifyAuthComplete } from "../api";

const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);

interface RegisterResponse {
  id: string;
  username: string;
}

export const RegisterView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);

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
        apiRequest<RegisterResponse>("/register", "POST", {
          username: data.get("username"),
          email: data.get("email"),
          password,
        }, {
          action: "auth.register.submit",
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
          <h2>Create Account</h2>
          <p class="auth-subtitle">Join postgres.garden</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div class="auth-field">
            <label>Username</label>
            <input
              type="text"
              name="username"
              class="setting-input"
              placeholder="Choose a username"
              autoFocus
            />
          </div>

          <div class="auth-field">
            <label>Email</label>
            <input
              type="email"
              name="email"
              class="setting-input"
              placeholder="you@example.com"
            />
          </div>

          <div class="auth-field">
            <label>Password</label>
            <input
              type="password"
              name="password"
              class="setting-input"
              placeholder="At least 8 characters"
            />
          </div>

          <div class="auth-field">
            <label>Confirm Password</label>
            <input type="password" name="confirmPassword" class="setting-input" />
          </div>

          {error && (
            <div class="auth-error">
              <i class="codicon codicon-error" />
              <span>{error}</span>
            </div>
          )}

          <button class="button auth-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <div class="auth-links">
          <button class="auth-link" onClick={() => props.onNavigate("login")}>
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
  });
