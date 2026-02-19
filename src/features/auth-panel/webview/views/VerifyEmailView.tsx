import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

const verifyingAtom = Atom.make(false);
const errorAtom = Atom.make<string | null>(null);
const successAtom = Atom.make(false);
const autoVerifiedAtom = Atom.make(false);

export function triggerVerification(emailId: string, token: string) {
  _pendingEmailId = emailId;
  _pendingToken = token;
}

let _pendingEmailId = "";
let _pendingToken = "";
let _autoVerifyAttempted = false;

export const VerifyEmailView = (props: { onNavigate: (view: string) => void }) =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const verifying = yield* Atom.get(verifyingAtom);
    const error = yield* Atom.get(errorAtom);
    const success = yield* Atom.get(successAtom);
    yield* Atom.get(autoVerifiedAtom);

    // Auto-verify if we have params from URL
    if (!_autoVerifyAttempted && _pendingEmailId && _pendingToken) {
      _autoVerifyAttempted = true;
      registry.set(verifyingAtom, true);

      void apiRequest("/api/verifyEmail", "POST", {
        emailId: _pendingEmailId,
        token: _pendingToken,
      })
        .then(() => {
          registry.set(successAtom, true);
          registry.set(autoVerifiedAtom, true);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(verifyingAtom, false);
        });
    }

    if (verifying) {
      return (
        <div class="auth-view">
          <div class="auth-header">
            <h2>Verifying Email</h2>
            <p class="auth-subtitle">Please wait...</p>
          </div>
        </div>
      );
    }

    if (success) {
      return (
        <div class="auth-view">
          <div class="auth-header">
            <h2>Email Verified</h2>
            <p class="auth-subtitle">Your email address has been verified successfully.</p>
          </div>

          <button class="button auth-button-primary" onClick={() => props.onNavigate("login")}>
            Continue
          </button>
        </div>
      );
    }

    if (error) {
      return (
        <div class="auth-view">
          <div class="auth-header">
            <h2>Verification Failed</h2>
          </div>

          <div class="auth-error">
            <i class="codicon codicon-error" />
            <span>{error}</span>
          </div>

          <div class="auth-links">
            <button class="auth-link" onClick={() => props.onNavigate("login")}>
              Back to sign in
            </button>
          </div>
        </div>
      );
    }

    return (
      <div class="auth-view">
        <div class="auth-header">
          <h2>Verify Email</h2>
          <p class="auth-subtitle">Check your inbox for a verification link.</p>
        </div>

        <div class="auth-links">
          <button class="auth-link" onClick={() => props.onNavigate("login")}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  });
