import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { sendInitialized, setOnInitView, setOnGitHubComplete, setOnGitHubError } from "./api";
import { LoginView } from "./views/LoginView";
import { RegisterView } from "./views/RegisterView";
import { ForgotPasswordView } from "./views/ForgotPasswordView";
import { ResetPasswordView, setResetParams } from "./views/ResetPasswordView";
import { VerifyEmailView, triggerVerification } from "./views/VerifyEmailView";
import { notifyAuthComplete } from "./api";

type ViewId = "login" | "register" | "forgot-password" | "reset-password" | "verify-email";

const activeViewAtom = Atom.make<ViewId>("login");
const githubErrorAtom = Atom.make<string | null>(null);

// Wire up extension host messages
setOnInitView((view, params) => {
  // This is called when the extension host tells us which view to show
  // (e.g., when opened from a /reset or /verify URL)
  if (view === "reset-password" && params?.userId && params?.token) {
    setResetParams(params.userId, params.token);
  }
  if (view === "verify-email" && params?.emailId && params?.token) {
    triggerVerification(params.emailId, params.token);
  }
  // We'll set the view via the registry in the component
  _pendingView = view as ViewId;
});

setOnGitHubComplete((username) => {
  notifyAuthComplete(username);
});

setOnGitHubError((message) => {
  _pendingGithubError = message;
});

let _pendingView: ViewId | null = null;
let _pendingGithubError: string | null = null;

// Tell extension we're ready
sendInitialized();

function renderView(view: ViewId, onNavigate: (v: string) => void) {
  switch (view) {
    case "login":
      return <LoginView onNavigate={onNavigate} />;
    case "register":
      return <RegisterView onNavigate={onNavigate} />;
    case "forgot-password":
      return <ForgotPasswordView onNavigate={onNavigate} />;
    case "reset-password":
      return <ResetPasswordView onNavigate={onNavigate} />;
    case "verify-email":
      return <VerifyEmailView onNavigate={onNavigate} />;
  }
}

export const AuthPanel = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const activeView = yield* Atom.get(activeViewAtom);
    const githubError = yield* Atom.get(githubErrorAtom);

    // Apply pending state from extension host
    if (_pendingView) {
      registry.set(activeViewAtom, _pendingView);
      _pendingView = null;
    }
    if (_pendingGithubError) {
      registry.set(githubErrorAtom, _pendingGithubError);
      _pendingGithubError = null;
    }

    function onNavigate(view: string) {
      registry.set(githubErrorAtom, null);
      registry.set(activeViewAtom, view as ViewId);
    }

    return (
      <div class="auth-container">
        {githubError && (
          <div class="auth-error" style={{ marginBottom: "16px" }}>
            <i class="codicon codicon-error" />
            <span>{githubError}</span>
          </div>
        )}
        {renderView(activeView, onNavigate)}
      </div>
    );
  });
