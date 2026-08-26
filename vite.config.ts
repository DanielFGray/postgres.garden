import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import wasm from "vite-plugin-wasm";
import solid from "@solidjs/vite-plugin";
import * as fs from "fs";
import path from "path";

export default defineConfig({
  server: {
    port: 3000,
    host: "0.0.0.0",
    // Build output and Playwright reports contain HTML files. Vite treats an
    // HTML change as a full-page reload, even though neither directory is an
    // input to the development app.
    watch: {
      ignored: ["**/dist/**", "**/playwright-report/**"],
    },
    fs: {
      allow: ["../"], // allow to load codicon.ttf from monaco-editor in the parent folder
    },
  },
  build: {
    target: "esnext",
    emptyOutDir: false,
    manifest: "manifest.json", // Generate manifest.json in outDir root for production asset resolution
  },
  worker: {
    format: "es",
  },
  plugins: [
    solid(),
    wasm(),
    {
      // The embedded workbench has global VS Code registrations, so a normal
      // module replacement is unsafe. Route source updates through loader.tsx:
      // it owns an Effect scope, waits for its finalizers, then reactivates the
      // plugin layer without replacing the workbench DOM or PGlite worker.
      name: "reload-workbench-plugins",
      apply: "serve",
      handleHotUpdate(ctx) {
        const generatedOutput = ["dist", "playwright-report"].some((directory) =>
          ctx.file.startsWith(path.join(import.meta.dirname, directory) + path.sep),
        );
        if (generatedOutput) {
          return [];
        }

        if (!ctx.file.startsWith(path.join(import.meta.dirname, "src") + path.sep)) {
          return;
        }

        const loader = ctx.server.moduleGraph.getModuleById(
          path.join(import.meta.dirname, "src", "loader.tsx"),
        );
        return loader ? [...ctx.modules, loader] : ctx.modules;
      },
    },
    {
      name: "load-vscode-css-as-string",
      enforce: "pre",
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, options);
        if (
          resolved &&
          resolved.id.match(
            /node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/,
          )
        ) {
          return {
            ...resolved,
            id: resolved.id + "?inline",
          };
        }
        return undefined;
      },
    },
    {
      // For the *-language-features extensions which use SharedArrayBuffer
      name: "configure-response-headers",
      apply: "serve",
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          next();
        });
      },
    },
    {
      name: "force-prevent-transform-assets",
      apply: "serve",
      configureServer(server) {
        return () => {
          server.middlewares.use(async (req, res, next) => {
            if (req.originalUrl != null) {
              const pathname = new URL(req.originalUrl, import.meta.url).pathname;
              if (pathname.endsWith(".html")) {
                res.setHeader("Content-Type", "text/html");
                res.writeHead(200);
                res.write(fs.readFileSync(path.join(import.meta.dirname, pathname)));
                res.end();
              }
            }

            next();
          });
        };
      },
    },
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        // Precache app shell only — JS is runtime-cached (CacheFirst) since it's content-hashed
        globPatterns: ["**/*.{css,html,ico,svg,woff,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  esbuild: {
    minifySyntax: false,
  },
  optimizeDeps: {
    // This is require because vite excludes local dependencies from being optimized
    // Monaco-vscode-api packages are local dependencies and the number of modules makes chrome hang
    include: [
      "@codingame/monaco-vscode-api/extensions",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-api/monaco",
      "vscode/localExtensionHost",

      // These 2 lines prevent vite from reloading the whole page when starting a worker (so 2 times in a row after cleaning the vite cache - for the editor then the textmate workers)
      // it's mainly empirical and probably not the best way, fix me if you find a better way
      "vscode-textmate",
      "vscode-oniguruma",
      "@vscode/vscode-languagedetection",
      "marked",
    ],
    exclude: ["@electric-sql/pglite", "@postgres-language-server/wasm"],
  },
  define: {
    rootDirectory: JSON.stringify(import.meta.dirname),
  },
  resolve: {
    dedupe: ["vscode"],
  },
});
