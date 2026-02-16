import type { Selectable } from "kysely";
import type { AppPublicUsers } from "../../../generated/db.js";

/** User profile returned by /api/me */
export type UserProfile = Selectable<AppPublicUsers>;

/** Webview → Extension host messages */
export type WebviewMessage =
  | { type: "initialized" }
  | {
      type: "request";
      id: string;
      endpoint: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
    };

/** Extension host → Webview messages */
export type ExtensionMessage =
  | { type: "data"; id: string; data: unknown }
  | { type: "error"; id: string; error: { code: string; message: string } }
  | { type: "offline" };
