import type { RequestTelemetryContext } from "../webview/requestTelemetry";

/** Webview → Extension host messages */
export type AuthWebviewMessage =
  | { type: "initialized" }
  | {
      type: "request";
      id: string;
      endpoint: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      telemetry?: RequestTelemetryContext;
    }
  | { type: "github-signin" }
  | { type: "auth-complete"; username: string };

/** Extension host → Webview messages */
export type AuthExtensionMessage =
  | { type: "data"; id: string; data: unknown }
  | { type: "error"; id: string; error: { code: string; message: string } }
  | { type: "github-complete"; username: string }
  | { type: "github-error"; message: string }
  | { type: "offline" }
  | { type: "init-view"; view: string; params?: Record<string, string> };

/** Callbacks from the panel provider to the auth provider */
export interface AuthPanelCallbacks {
  onAuth(username: string): void;
  onGitHubSignIn(): void;
  onCancel(): void;
}
