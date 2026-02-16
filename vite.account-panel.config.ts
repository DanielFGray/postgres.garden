import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  build: {
    lib: {
      entry: resolve(
        __dirname,
        "src/features/account/webview/index.tsx",
      ),
      formats: ["es"],
      fileName: "account-settings-panel",
    },
    outDir: "src/features/account/panel-dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
});
