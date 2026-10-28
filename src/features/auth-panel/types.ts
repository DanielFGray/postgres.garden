import * as S from "effect/Schema";
import { RelayRequest } from "../webview/relayProtocol";

export class Initialized extends S.Class<Initialized, { readonly brand: unique symbol }>(
  "Initialized",
)({ type: S.Literal("initialized") }) {}

/** GitHub sign-in navigates the top-level window, so the host starts it, not an API call. */
export class GitHubSignIn extends S.Class<GitHubSignIn, { readonly brand: unique symbol }>(
  "GitHubSignIn",
)({ type: S.Literal("github-signin") }) {}

export class AuthComplete extends S.Class<AuthComplete, { readonly brand: unique symbol }>(
  "AuthComplete",
)({ type: S.Literal("auth-complete"), username: S.String }) {}

/** Webview → Extension host messages */
export const AuthWebviewMessage = S.Union([Initialized, GitHubSignIn, AuthComplete, RelayRequest]);

export const ViewId = S.Literals([
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
]);
export type ViewId = typeof ViewId.Type;

export class GitHubComplete extends S.Class<GitHubComplete, { readonly brand: unique symbol }>(
  "GitHubComplete",
)({
  type: S.Literal("github-complete"),
  username: S.String,
}) {}

export class GitHubError extends S.Class<GitHubError, { readonly brand: unique symbol }>(
  "GitHubError",
)({ type: S.Literal("github-error"), message: S.String }) {}

export class InitView extends S.Class<InitView, { readonly brand: unique symbol }>("InitView")({
  type: S.Literal("init-view"),
  view: S.optional(ViewId),
  params: S.optional(S.Record(S.String, S.String)),
}) {}

/** Extension host → Webview messages */
export const AuthHostMessage = S.Union([GitHubComplete, GitHubError, InitView]);

/** Callbacks from the panel provider to the auth provider */
export interface AuthPanelCallbacks {
  onAuth(username: string): void;
  onGitHubSignIn(): void;
  onCancel(): void;
}
