import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    allowCypressEnv: false,
    baseUrl: "http://localhost:3000",
    supportFile: "cypress/support/e2e.ts",
    specPattern: "cypress/e2e/**/*.cy.{js,jsx,ts,tsx}",
    fixturesFolder: "cypress/fixtures",
    screenshotsFolder: "cypress/screenshots",
    videosFolder: "cypress/videos",
    video: false,
    viewportWidth: 1280,
    viewportHeight: 720,
    // VSCode workbench takes time to load (300+ extensions)
    requestTimeout: 10000, // 10s for requests
    responseTimeout: 30000, // 30s for responses
    pageLoadTimeout: 120000, // 2min for initial page load
    retries: {
      runMode: 2,
      openMode: 0,
    },
    env: {
      VITE_ROOT_URL: "http://localhost:3000",
    },
    setupNodeEvents() {
      // implement node event listeners here if needed
    },
  },
});
