import { defineConfig } from "vitest/config";

export default defineConfig({
  // Server code imports `lib/*` and `generated/*` through tsconfig `paths`.
  resolve: { tsconfigPaths: true },
  test: {
    include: ["server/**/*.test.ts", "worker/**/*.test.ts", "src/features/**/*.test.ts"],
  },
});
