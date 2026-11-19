import * as fs from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Server code imports `lib/*` and `generated/*` through tsconfig `paths`.
  resolve: { tsconfigPaths: true },
  plugins: [
    {
      // Bun and esbuild embed `import x from "./a.mjml" with { type: "text" }`
      // themselves; Vite does not, so tests load the file as a string module.
      name: "mjml-text",
      enforce: "pre",
      load(id) {
        if (!id.endsWith(".mjml")) return null;
        return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
      },
    },
  ],
  test: {
    include: ["server/**/*.test.ts", "worker/**/*.test.ts", "src/features/**/*.test.ts"],
    // Database tests run against `<DATABASE_NAME>_test`, rebuilt once per run.
    globalSetup: ["./server/test/globalSetup.ts"],
    setupFiles: ["./server/test/setup.ts"],
  },
});
