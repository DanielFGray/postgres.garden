import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const emailAtom = Atom.make("");
const submittingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const sentAtom = Atom.make(false);

export const ForgotPasswordView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const email = yield* Atom.get(emailAtom);
    const submitting = yield* Atom.get(submittingAtom);
    const error = yield* Atom.get(errorAtom);
    const sent = yield* Atom.get(sentAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      registry.set(errorAtom, null);
      registry.set(submittingAtom, true);

      void apiRequest("/api/forgotPassword", "POST", {
        email: registry.get(emailAtom),
      })
        .then(() => {
          registry.set(sentAtom, true);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(submittingAtom, false);
        });
    }

    if (sent) {
      return (
        <div class="auth-view">
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
                registry.set(sentAtom, false);
                registry.set(emailAtom, "");
                props.onNavigate("login");
              }}
            >
              Back to sign in
            </button>
          </div>
        </div>
      );
    }

    return (
      <div class="auth-view">
        <div class="auth-header">
          <h2>Forgot Password</h2>
          <p class="auth-subtitle">
            Enter your email and we'll send you a link to reset your password.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
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
              autoFocus
            />
          </div>

          {error && (
            <div class="auth-error">
              <i class="codicon codicon-error" />
              <span>{error}</span>
            </div>
          )}

          <button class="button auth-button-primary" type="submit" disabled={submitting}>
            {submitting ? "Sending..." : "Send Reset Link"}
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
