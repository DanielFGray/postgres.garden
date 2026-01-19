import { defineConfig } from "vite";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import * as fs from "fs";
import path from "path";
import tsconfigPaths from "vite-tsconfig-paths";

const proxyTarget = `http://localhost:${process.env.PORT}`;

export default defineConfig({
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["~lib"],
    },
  },
  worker: {
    format: "es",
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/auth": {
        target: proxyTarget,
        changeOrigin: true,
      },
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [
    tsconfigPaths(),
    {
      // For the *-language-features extensions which use SharedArrayBuffer
      name: "configure-response-headers",
      apply: "serve",
      configureServer: server => {
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
              const pathname = new URL(req.originalUrl, import.meta.url)
                .pathname;
              if (pathname.endsWith(".html")) {
                res.setHeader("Content-Type", "text/html");
                res.writeHead(200);
                res.write(fs.readFileSync(path.join(__dirname, pathname)));
                res.end();
              }
            }

            next();
          });
        };
      },
    },
  ],
  optimizeDeps: {
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
    exclude: ["@electric-sql/pglite"],
    esbuildOptions: {
      tsconfig: "./tsconfig.json",
      plugins: [importMetaUrlPlugin],
    },
  },
  define: {
    rootDirectory: JSON.stringify(__dirname),
  },
  resolve: {
    alias: [
      {
        find: /^@codingame\/monaco-vscode-api\/vscode\//,
        replacement: `${path.resolve(
          __dirname,
          "node_modules/@codingame/monaco-vscode-api/vscode/src/",
        )}/`,
      },
    ],
    dedupe: ["vscode"],
  },
});
