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
      "vscode-extension-samples/**",
      "migrations/**",
      "src/features/notebook/renderer/pev2/**",
      "src/features/notebook/renderer-dist/**",
      "src/webview-dist/**",
      "src/features/remoteExtensionExample/**",
      "server/vendor/**",
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
        projectService: {
          allowDefaultProject: [],
          defaultProject: "tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Service worker uses its own tsconfig (WebWorker lib, not DOM)
  {
    files: ["src/sw.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "tsconfig.sw.json",
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

  // k6 load tests — no tsconfig, k6-specific globals
  {
    files: ["k6/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
      globals: {
        console: true,
        __VU: true,
        __ITER: true,
        __ENV: true,
      },
    },
  },

  // graphile-worker tasks — no tsconfig, Node globals
  {
    files: ["worker/**/*.js", "worker/**/*.d.ts"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: null,
      },
      globals: {
        console: true,
        process: true,
        global: true,
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
