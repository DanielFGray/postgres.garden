import type { Selectable } from "kysely";
import type { AppPublicUsers as User } from "../../../generated/db.js";
import type { RequestTelemetryContext } from "../webview/requestTelemetry";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** User profile returned by /api/me */
export type UserProfile = Selectable<User>;

/** Webview → Extension host messages */
export type WebviewMessage =
  | { type: "initialized" }
  | { type: "account-deleted" }
  | {
      type: "request";
      id: string;
      endpoint: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: JsonValue;
      telemetry?: RequestTelemetryContext;
    };

/** Extension host → Webview messages */
export type ExtensionMessage =
  | { type: "data"; id: string; data: unknown }
  | { type: "error"; id: string; error: { code: string; message: string } }
  | { type: "offline" }
  | { type: "init-state"; section?: string; deleteToken?: string };
