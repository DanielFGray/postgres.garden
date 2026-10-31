import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker, measured on this suite: 1 worker passes all 15, 2 workers fail
  // 2, and 4 workers fail 10, one of them with a crashed browser. Each worker
  // drives a whole VS Code workbench with PGlite in WASM against the dev
  // server, and the contention reads as timeouts waiting for UI.
  workers: 1,
  // The reset that clears test users and every session belongs to the whole
  // run, not to a worker. See e2e/globalSetup.ts.
  globalSetup: "./e2e/globalSetup.ts",
  // The html reporter opens the report in a browser on failure whenever it is
  // run from a terminal, which hijacks the keyboard in the middle of a gate run.
  reporter: [["line"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use system Chromium — Playwright's bundled browsers don't work on Arch
        launchOptions: {
          executablePath: "/usr/bin/chromium",
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          executablePath: "/usr/bin/firefox",
        },
      },
    },
  ],
});
