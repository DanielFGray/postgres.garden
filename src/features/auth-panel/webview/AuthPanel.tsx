import { createSignal, onCleanup, Show, Switch, Match } from "solid-js";
import { notifyAuthComplete, sendInitialized } from "./api";
import { LoginView } from "./views/LoginView";
import { RegisterView } from "./views/RegisterView";
import { ForgotPasswordView } from "./views/ForgotPasswordView";
import { ResetPasswordView, setResetParams } from "./views/ResetPasswordView";
import { VerifyEmailView, triggerVerification } from "./views/VerifyEmailView";
import * as S from "effect/Schema";
import { Match as M, Option } from "effect";
import { AuthHostMessage, ViewId } from "../types";

export const AuthPanel = () => {
  const [activeView, setActiveView] = createSignal<ViewId>("login");
  const [githubError, setGithubError] = createSignal<string | null>(null);

  const handleHostMessage = (message: MessageEvent) => {
    Option.map(S.decodeUnknownOption(AuthHostMessage)(message.data), (msg) =>
      M.value(msg).pipe(
        M.discriminator("type")("github-complete", ({ username }) => notifyAuthComplete(username)),
        M.discriminator("type")("github-error", ({ message }) => setGithubError(message)),
        M.discriminator("type")("init-view", ({ view = "login", params }) => {
          if (view === "reset-password" && params?.userId && params?.token) {
            setResetParams(params.userId, params.token);
          }
          if (view === "verify-email" && params?.emailId && params?.token) {
            triggerVerification(params.emailId, params.token);
          }
          setActiveView(view);
        }),
        M.exhaustive,
      ),
    );
  };

  window.addEventListener("message", handleHostMessage);
  sendInitialized();
  onCleanup(() => window.removeEventListener("message", handleHostMessage));

  function onNavigate(view: string) {
    setGithubError(null);
    Option.map(S.decodeUnknownOption(ViewId)(view), setActiveView);
  }

  return (
    <div class="auth-container" data-pw="auth-panel" data-pw-view={activeView()}>
      <Show when={githubError()}>
        {(message) => (
          <div class="auth-error" style={{ "margin-bottom": "16px" }} data-pw="github-auth-error">
            <i class="codicon codicon-error" />
            <span>{message()}</span>
          </div>
        )}
      </Show>
      <Switch>
        <Match when={activeView() === "login"}>
          <LoginView onNavigate={onNavigate} />
        </Match>
        <Match when={activeView() === "register"}>
          <RegisterView onNavigate={onNavigate} />
        </Match>
        <Match when={activeView() === "forgot-password"}>
          <ForgotPasswordView onNavigate={onNavigate} />
        </Match>
        <Match when={activeView() === "reset-password"}>
          <ResetPasswordView onNavigate={onNavigate} />
        </Match>
        <Match when={activeView() === "verify-email"}>
          <VerifyEmailView onNavigate={onNavigate} />
        </Match>
      </Switch>
    </div>
  );
};
