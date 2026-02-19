import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  esbuild: {
    jsx: "transform",
    jsxFactory: "jsx",
    jsxFragment: "Fragment",
    jsxInject: `import { jsx, Fragment } from 'fibrae/jsx-runtime'`,
  },
  build: {
    lib: {
      entry: {
        "playground-view": resolve(
          __dirname,
          "src/features/playground/webview/view-preact/index.tsx",
        ),
        "playground-panel": resolve(
          __dirname,
          "src/features/playground/webview/panel-preact/index.tsx",
        ),
        "erd-viewer": resolve(__dirname, "src/features/erd/webview/entry.tsx"),
        "account-settings": resolve(__dirname, "src/features/account/webview/index.tsx"),
      },
      formats: ["es"],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    outDir: "src/webview-dist",
    emptyOutDir: true,
    minify: false, // Easier debugging during development
    sourcemap: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
        manualChunks: undefined,
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
