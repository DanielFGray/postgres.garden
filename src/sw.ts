/**
 * Service Worker for postgres.garden
 *
 * Caching strategy:
 * - HTML navigation: network, with the precached shell as the offline fallback
 * - Precached assets (from Vite manifest): cache-first (hash-versioned, immutable)
 * - API calls: network-only (never cache auth/mutation endpoints)
 * - WASM files: cache-first on first use (large, content-hashed)
 *
 * Cross-Origin Isolation:
 * All responses get COEP/COOP/CORP headers injected so SharedArrayBuffer
 * works even when served from cache (required for VSCode language features).
 */

import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import {
  NavigationRoute,
  registerRoute,
  setDefaultHandler,
  setCatchHandler,
} from "workbox-routing";
import { CacheFirst, NetworkFirst, NetworkOnly } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";

// Shadow the global `self` with the correct ServiceWorkerGlobalScope type.
// The WebWorker lib types `self` as WorkerGlobalScope; this narrows it.
// workbox-precaching already augments ServiceWorkerGlobalScope with __WB_MANIFEST.
declare const self: ServiceWorkerGlobalScope;

// ── Lifecycle ──────────────────────────────────────────────────────────

// Take control immediately on install (skip waiting)
void self.skipWaiting();
clientsClaim();

// Clean up caches from previous SW versions
cleanupOutdatedCaches();

// ── Cross-Origin Isolation Headers ─────────────────────────────────────
// SharedArrayBuffer requires these headers on every response.
// When serving from cache, the original headers may be missing,
// so we inject them on every fetch response.

const COI_HEADERS = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function addCoiHeaders(response: Response): Response {
  if (response.type === "opaque") return response;

  const headers = new Headers(response.headers);
  Object.entries(COI_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Navigation: network ────────────────────────────────────────────────
// The page names the hashed scripts it loads, and a deploy removes the
// previous build's scripts from the server. A page served from the cache
// after a deploy loads scripts that are gone: the language server worker and
// the notebook renderer fail to load. So a page always comes from the server
// while the server answers, and the precached shell is only the offline
// fallback (see setCatchHandler). This route comes before the precache route,
// because the router takes the first route that matches, and the precache
// route matches "/" through its "index.html" entry.

registerRoute(new NavigationRoute(new NetworkOnly()));

// ── Precache (Vite build manifest injection) ───────────────────────────
// vite-plugin-pwa injects the precache manifest here at build time.
// This covers the app shell: HTML, CSS, fonts, icons.
// Hash-versioned filenames ensure cache-busting on deploys.

precacheAndRoute(self.__WB_MANIFEST);

// ── WASM files: cache-first (large, content-hashed) ────────────────────
// PGlite WASM (~8.5MB) and other WASM assets use content-hash filenames.
// Cache on first use, serve from cache on subsequent loads.

registerRoute(
  ({ request }) => request.url.endsWith(".wasm"),
  new CacheFirst({
    cacheName: "wasm-cache",
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// ── API routes: network-only ───────────────────────────────────────────
// Never cache API calls — they contain user-specific data, mutations,
// and auth state that must always be fresh.

registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/webhooks"),
  new NetworkOnly(),
);

// ── Hash-versioned JS/CSS assets: cache-first ───────────────────────────
// Vite outputs content-hashed filenames to /assets/. Safe to cache-first.
// These are NOT precached (too large) — cached on first use instead.

registerRoute(
  ({ url }) => url.pathname.startsWith("/assets/"),
  new CacheFirst({
    cacheName: "versioned-assets",
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// ── Static assets (fonts, images): cache-first ─────────────────────────

registerRoute(
  ({ request }) => request.destination === "font" || request.destination === "image",
  new CacheFirst({
    cacheName: "static-assets",
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// ── Default: network-first ─────────────────────────────────────────────
// Everything else (JS modules, CSS not in precache, etc.)

setDefaultHandler(
  new NetworkFirst({
    cacheName: "default-cache",
    networkTimeoutSeconds: 5,
  }),
);

// ── Offline fallback for navigation requests ───────────────────────────
// If a navigation request fails (offline), serve the cached app shell.
// The app shell boots the VSCode workbench which works offline via PGlite.

setCatchHandler(async ({ request }) => {
  if (request.destination === "document") {
    const shell = await matchPrecache("index.html");
    if (shell) return addCoiHeaders(shell);
  }
  return Response.error();
});

// ── Update notification ────────────────────────────────────────────────
// When a new SW version is installed, notify the client so it can
// show an "Update available" toast.

self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
