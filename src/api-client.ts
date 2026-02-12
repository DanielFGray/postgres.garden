/**
 * Type-safe API client using Elysia Eden Fetch
 */
import { edenFetch } from "@elysiajs/eden";
import type { App } from "../server/app";

// Create eden fetch client for browser with credentials included
// This ensures cookies (including session cookie) are sent with every request
// The /api prefix matches the Elysia app prefix defined in server/app.ts
export const api = edenFetch<App>(window.location.origin, {
  credentials: "include",
});
