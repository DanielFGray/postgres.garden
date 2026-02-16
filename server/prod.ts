/**
 * Production server that serves pre-built Vite assets
 * Uses Vite manifest to resolve correct asset paths
 * Injects initial data into the HTML shell on each request
 */

import { Elysia } from "elysia";
import { staticPlugin } from "./vendor/@elysiajs/static/index.js";
import fs from "fs";
import path from "path";
import { getInitialData } from "./ssr.js";
import type { App } from "./app.js";

interface ManifestChunk {
  file: string;
  src?: string;
  css?: string[];
  assets?: string[];
  isEntry?: boolean;
  imports?: string[];
}

type Manifest = Record<string, ManifestChunk>;

/**
 * Recursively collect all imported chunks for preloading
 */
function getImportedChunks(
  manifest: Manifest,
  name: string,
  seen = new Set<string>(),
): ManifestChunk[] {
  const chunk = manifest[name];
  if (!chunk) return [];

  const chunks: ManifestChunk[] = [];
  for (const file of chunk.imports ?? []) {
    if (seen.has(file)) continue;
    seen.add(file);

    const importee = manifest[file];
    if (importee) {
      chunks.push(...getImportedChunks(manifest, file, seen));
      chunks.push(importee);
    }
  }
  return chunks;
}

/**
 * Generate HTML with correct asset paths from manifest
 */
function generateHtmlFromManifest(
  manifest: Manifest,
  entryPoint: string,
): string {
  const entry = manifest[entryPoint];
  if (!entry) {
    throw new Error(`Entry point "${entryPoint}" not found in manifest`);
  }

  const importedChunks = getImportedChunks(manifest, entryPoint);

  // Collect all CSS files
  const cssFiles = new Set<string>();
  if (entry.css) {
    entry.css.forEach((css) => cssFiles.add(css));
  }
  for (const chunk of importedChunks) {
    if (chunk.css) {
      chunk.css.forEach((css) => cssFiles.add(css));
    }
  }

  // Generate link tags for CSS
  const cssLinks = Array.from(cssFiles)
    .map((css) => `  <link rel="stylesheet" crossorigin href="/${css}">`)
    .join("\n");

  // Generate modulepreload links for imported chunks
  const preloadLinks = importedChunks
    .map(
      (chunk) =>
        `  <link rel="modulepreload" crossorigin href="/${chunk.file}">`,
    )
    .join("\n");

  // Find favicon in manifest
  let faviconPath = "/favicon.ico";
  const faviconEntry = manifest["favicon.ico"];
  if (faviconEntry) {
    faviconPath = `/${faviconEntry.file}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>postgres.garden</title>
  <link rel="icon" href="${faviconPath}" type="image/x-icon" />
  <script type="module" crossorigin src="/${entry.file}"></script>
${preloadLinks}
${cssLinks}
</head>
<body></body>
<!-- {INITIAL_DATA} -->
</html>
`;
}

/**
 * Create and return a production Elysia instance with static serving
 */
export async function createProdServer(rootApp: App) {
  const DIST_DIR = path.resolve(process.cwd(), "dist");
  const MANIFEST_PATH = path.join(DIST_DIR, "manifest.json");

  // Verify build directory exists
  if (!fs.existsSync(DIST_DIR)) {
    console.error("❌ Build directory not found. Run `bun run build` first.");
    process.exit(1);
  }

  // Read and parse the Vite manifest
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(
      "❌ Vite manifest not found. Ensure build.manifest is enabled in vite.config.ts",
    );
    process.exit(1);
  }

  const manifest = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf-8"),
  ) as Manifest;

  // Generate HTML template from manifest
  // The entry point is index.html (Vite uses index.html as the entry)
  const htmlTemplate = generateHtmlFromManifest(manifest, "index.html");

  console.log("✓ Loaded Vite manifest, resolved entry point: index.html");

  const app = new Elysia();

  // Add CORS headers for SharedArrayBuffer support
  app.onRequest(({ set }) => {
    set.headers["Cross-Origin-Embedder-Policy"] = "credentialless";
    set.headers["Cross-Origin-Opener-Policy"] = "same-origin";
    set.headers["Cross-Origin-Resource-Policy"] = "cross-origin";
  });

  // Service worker must never be long-cached — browsers need to detect updates
  const swPath = path.join(DIST_DIR, "sw.js");
  if (fs.existsSync(swPath)) {
    app.get("/sw.js", () => new Response(Bun.file(swPath), {
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-cache",
      },
    }));
  }

  // Serve static assets from dist directory FIRST
  // Static routes must be registered before the catch-all
  app.use(
    await staticPlugin({
      assets: DIST_DIR,
      prefix: "/",
      alwaysStatic: true,
      indexHTML: false,
    }),
  );

  // SPA catch-all route - serves HTML shell for all non-static routes
  app.get("/*", async ({ set, request }) => {
    try {
      const url = new URL(request.url);

      // Get cookie header from request
      const cookieHeader = request.headers.get("cookie") || "";

      // Fetch initial data using shared SSR helper
      const initialData = await getInitialData(
        rootApp,
        url.pathname,
        cookieHeader,
      );

      // Inject initial data into the HTML
      const html = htmlTemplate.replace(
        "<!-- {INITIAL_DATA} -->",
        `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`,
      );

      set.headers["Content-Type"] = "text/html";
      return html;
    } catch (e) {
      console.error("Error serving HTML:", e);
      return new Response("Internal Server Error", { status: 500 });
    }
  });

  return app;
}
