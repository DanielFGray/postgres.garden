#!/usr/bin/env bun
/**
 * Server entry point that supports both development and production modes
 *
 * Development: Uses Vite dev server with SSR transformation
 * Production: Serves pre-built static assets with data injection
 */

import { Effect } from "effect";
import { app } from "./app.js";
import { env } from "./assertEnv.js";
import { createDevServer } from "./dev.js";
import { createProdServer } from "./prod.js";
import { waitForDependencies } from "./ready.js";

const isDev = env.NODE_ENV !== "production";
const PORT = Number(env.PORT);
const HOST = process.env.HOST || "0.0.0.0";

// Wait for Postgres and Valkey before starting
await Effect.runPromise(waitForDependencies);

export { app };

// Add testing routes in dev/test mode only (BEFORE creating dev server)
// Use dynamic import to avoid loading testing.ts in production
if (isDev || env.NODE_ENV === "test") {
  const { testingServer } = await import("./testing.js");
  app.use(testingServer);
  console.log("✓ Testing commands mounted at /api/testingCommand");
}

export type App = typeof app;

if (isDev) {
  console.log("🚀 Starting development server with Vite SSR...");

  // Create and start Vite dev server (it handles API routes internally)
  const vite = await createDevServer(app);

  // Vite dev server starts automatically when created
  // The HTTP server is accessible via vite.httpServer
  const resolvedPort = vite.config.server.port || PORT;

  if (!vite.httpServer) {
    throw new Error("Vite HTTP server not available");
  }

  console.log(`
  Development Server Running
  Local:   http://localhost:${resolvedPort}
  Network: http://${HOST}:${resolvedPort}
-----------------------------------------
  SSR data injection: ✓ enabled
  Vite HMR:           ✓ enabled
  API routes:         ✓ enabled
-----------------------------------------
  `);

  // Handle graceful shutdown on SIGINT and SIGTERM
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n${signal} received, shutting down gracefully...`);
    try {
      await vite.close();
      console.log("✓ Vite server closed");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
} else {
  console.log("🚀 Starting production server...");

  // Create production app and mount shared routers
  app.use(await createProdServer(app));
  const server = app.listen(PORT, () => {
    console.log(`
  Production Server Running
  Local:   http://localhost:${PORT}
  Network: http://${HOST}:${PORT}
-----------------------------------------
  SSR data injection: ✓ enabled
  Serving from:       ./dist
-----------------------------------------
    `);
  });

  // Handle graceful shutdown on SIGINT and SIGTERM
  let isShuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n${signal} received, shutting down gracefully...`);
    try {
      void server.stop();
      console.log("✓ Production server closed");
      process.exit(0);
    } catch (error) {
      console.error("Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}
