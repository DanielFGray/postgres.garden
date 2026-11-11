import { createSignal, Match, onSettled, Switch } from "solid-js";
import { apiCall } from "../api";
import * as Effect from "effect/Effect";
import { runRequest } from "../../../webview/request";

// Set by the host's `init-view` message before this view mounts. A signal, not
// a plain variable: the view renders once, so a plain write after mount would
// never reach the DOM.
const [pendingToken, setPendingToken] = createSignal<string | null>(null);
let autoVerifyAttempted = false;

export function triggerVerification(token: string) {
  setPendingToken(token);
}

export const VerifyEmailView = (props: { onNavigate: (view: string) => void }) => {
  const [verifying, setVerifying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  // Signal writes are not allowed while the component renders, so the request starts once mounted.
  onSettled(() => {
    const token = pendingToken();
    if (autoVerifyAttempted || !token) return;
    autoVerifyAttempted = true;
    setVerifying(true);
    void runRequest(
      apiCall("auth.verify_email.auto", (api) =>
        api.apiUsers.verifyEmail({ payload: { token } }),
      ).pipe(
        Effect.match({
          onFailure: (error) => setError(error.message),
          onSuccess: () => setSuccess(true),
        }),
        Effect.ensuring(Effect.sync(() => setVerifying(false))),
      ),
    );
  });

  return (
    <Switch>
      <Match when={verifying()}>
        <div class="auth-view">
          <div class="auth-header">
            <h2>Verifying Email</h2>
            <p class="auth-subtitle">Please wait...</p>
          </div>
        </div>
      </Match>

      <Match when={success()}>
        <div class="auth-view" data-pw="email-verified">
          <div class="auth-header">
            <h2>Email Verified</h2>
            <p class="auth-subtitle">Your email address has been verified successfully.</p>
          </div>

          <button class="button auth-button-primary" onClick={() => props.onNavigate("login")}>
            Continue
          </button>
        </div>
      </Match>

      <Match when={error()}>
        {(message) => (
          <div class="auth-view">
            <div class="auth-header">
              <h2>Verification Failed</h2>
            </div>

            <div class="auth-error">
              <i class="codicon codicon-error" />
              <span>{message()}</span>
            </div>

            <div class="auth-links">
              <button class="auth-link" onClick={() => props.onNavigate("login")}>
                Back to sign in
              </button>
            </div>
          </div>
        )}
      </Match>

      <Match when={true}>
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
      </Match>
    </Switch>
  );
};
