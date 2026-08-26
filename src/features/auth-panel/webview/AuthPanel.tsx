import { createSignal, onCleanup, Show, Switch, Match } from "solid-js";
import { notifyAuthComplete, sendInitialized } from "./api";
import { LoginView } from "./views/LoginView";
import { RegisterView } from "./views/RegisterView";
import { ForgotPasswordView } from "./views/ForgotPasswordView";
import { ResetPasswordView, setResetParams } from "./views/ResetPasswordView";
import { VerifyEmailView, triggerVerification } from "./views/VerifyEmailView";
import * as S from "effect/Schema";
import { Match as EffectMatch } from "effect";

type ViewId = "login" | "register" | "forgot-password" | "reset-password" | "verify-email";

const ViewIdSchema = S.Literal(
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
);
const HostMessage = S.Union(
  S.Struct({ type: S.Literal("github-complete"), username: S.String }),
  S.Struct({ type: S.Literal("github-error"), message: S.String }),
  S.Struct({
    type: S.Literal("init-view"),
    view: S.optional(ViewIdSchema),
    params: S.optional(S.Record({ key: S.String, value: S.String })),
  }),
);

export const AuthPanel = () => {
  const [activeView, setActiveView] = createSignal<ViewId>("login");
  const [githubError, setGithubError] = createSignal<string | null>(null);

  const handleHostMessage = (message: MessageEvent) => {
    const msg = EffectMatch.value(S.decodeUnknownOption(HostMessage)(message.data)).pipe(
      EffectMatch.tags({ None: () => undefined, Some: ({ value }) => value }),
      EffectMatch.exhaustive,
    );
    if (msg === undefined) return;
    if (msg.type === "github-complete") {
      notifyAuthComplete(msg.username);
    } else if (msg.type === "github-error") {
      setGithubError(msg.message);
    } else if (msg.type === "init-view") {
      const view = msg.view ?? "login";
      const params = msg.params;
      if (view === "reset-password" && params?.userId && params?.token) {
        setResetParams(params.userId, params.token);
      }
      if (view === "verify-email" && params?.emailId && params?.token) {
        triggerVerification(params.emailId, params.token);
      }
      setActiveView(view);
    }
  };

  window.addEventListener("message", handleHostMessage);
  sendInitialized();
  onCleanup(() => window.removeEventListener("message", handleHostMessage));

  function onNavigate(view: string) {
    setGithubError(null);
    const parsed = EffectMatch.value(S.decodeUnknownOption(ViewIdSchema)(view)).pipe(
      EffectMatch.tags({ None: () => undefined, Some: ({ value }) => value }),
      EffectMatch.exhaustive,
    );
    if (parsed !== undefined) setActiveView(parsed);
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
