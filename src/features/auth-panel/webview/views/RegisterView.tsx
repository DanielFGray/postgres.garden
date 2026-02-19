import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest, signInWithGitHub, notifyAuthComplete } from "../api";

const usernameAtom = Atom.make("");
const emailAtom = Atom.make("");
const passwordAtom = Atom.make("");
const confirmPasswordAtom = Atom.make("");
const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);

interface RegisterResponse {
  id: string;
  username: string;
}

export const RegisterView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const username = yield* Atom.get(usernameAtom);
    const email = yield* Atom.get(emailAtom);
    const password = yield* Atom.get(passwordAtom);
    const confirmPassword = yield* Atom.get(confirmPasswordAtom);
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);

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

      void apiRequest<RegisterResponse>("/register", "POST", {
        username: registry.get(usernameAtom),
        email: registry.get(emailAtom),
        password: pw,
      })
        .then((data) => {
          notifyAuthComplete(data.username);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(submittingAtom, false);
        });
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
              class="setting-input"
              placeholder="Choose a username"
              value={username}
              onInput={(e: Event) => {
                registry.set(usernameAtom, (e.target as HTMLInputElement).value);
              }}
              autoFocus
            />
          </div>

          <div class="auth-field">
            <label>Email</label>
            <input
              type="email"
              class="setting-input"
              placeholder="you@example.com"
              value={email}
              onInput={(e: Event) => {
                registry.set(emailAtom, (e.target as HTMLInputElement).value);
              }}
            />
          </div>

          <div class="auth-field">
            <label>Password</label>
            <input
              type="password"
              class="setting-input"
              placeholder="At least 8 characters"
              value={password}
              onInput={(e: Event) => {
                registry.set(passwordAtom, (e.target as HTMLInputElement).value);
              }}
            />
          </div>

          <div class="auth-field">
            <label>Confirm Password</label>
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
