import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import vue from '@vitejs/plugin-vue';

/**
 * Vite plugin that captures extracted CSS and inlines it as a string export
 * in the JS bundle. This is necessary because VS Code notebook renderers only
 * load the JS entrypoint — a separate CSS file would never be loaded.
 *
 * The CSS string is made available via `import cssText from 'virtual:renderer-css'`
 * so the renderer can inject it into its Shadow DOM.
 */
function inlineCssPlugin(): Plugin {
  const virtualId = 'virtual:renderer-css';
  const resolvedVirtualId = '\0' + virtualId;
  // Unique marker that survives bundler transforms (inlineDynamicImports
  // converts `export default "..."` into `const cssText = "..."`)
  const CSS_PLACEHOLDER = '__RENDERER_CSS_PLACEHOLDER_a9f3e7__';

  return {
    name: 'inline-css-into-js',
    enforce: 'post' as const,
    resolveId(id) {
      if (id === virtualId) return resolvedVirtualId;
    },
    load(id) {
      if (id === resolvedVirtualId) {
        return `export default "${CSS_PLACEHOLDER}"`;
      }
    },
    generateBundle(_, bundle) {
      // Collect and remove all CSS assets
      let extractedCss = '';
      for (const [key, chunk] of Object.entries(bundle)) {
        if (key.endsWith('.css') && chunk.type === 'asset') {
          extractedCss += chunk.source;
          delete bundle[key];
        }
      }

      // Replace the placeholder marker in the JS entry with the real CSS
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          chunk.code = chunk.code.replace(
            `"${CSS_PLACEHOLDER}"`,
            JSON.stringify(extractedCss),
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    inlineCssPlugin(),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    '__APP_VERSION__': JSON.stringify('vendored'),
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/features/notebook/renderer/index.tsx'),
      formats: ['es'],
      fileName: 'sql-renderer',
    },
    outDir: 'src/features/notebook/renderer-dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ['vscode-notebook-renderer'],
      output: {
        // Disable code splitting - VS Code notebook renderers can't resolve relative chunk imports
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
      '@': resolve(__dirname, 'src/features/notebook/renderer/pev2'),
    },
  },
});
