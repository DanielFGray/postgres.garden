// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import cypress from "eslint-plugin-cypress";

export default [
  // Ignore patterns
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.config.js",
      "*.config.ts",
      "test-env.ts",
      "vscode-extension-samples/**",
      "patches/**",
      "migrations/**",
      "lib/**",
      "scripts/**",
      "worker/**",
      "src/features/notebook/renderer/pev2/**",
      "src/features/notebook/renderer-dist/**",
      "src/features/playground/webview-dist/**",
      "src/features/remoteExtensionExample/**",
      "src/debugServer.ts",
      "server/debugServer.ts",
      "server/vendor/**",
      "src/features/erd/**",
      "src/sw.ts",
    ],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript recommended type-checked configuration
  ...tseslint.configs.recommendedTypeChecked,

  // Project-specific TypeScript configuration
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Cypress-specific configuration for test files
  {
    files: ["cypress/**/*.{js,ts}"],
    plugins: {
      cypress,
    },
    rules: {
      ...cypress.configs.recommended.rules,
    },
    languageOptions: {
      globals: {
        cy: true,
        Cypress: true,
        expect: true,
        assert: true,
      },
    },
  },

  // Additional rules or overrides can be added here
  {
    rules: {
      // Add any custom rules or overrides here
      // Example: '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
];
