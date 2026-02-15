#!/usr/bin/env bun
/**
 * Production-only server entry point for standalone builds
 * 
 * This entry point is used when building with `bun build --compile`
 * It only imports production dependencies and avoids dev-only code like Vite
 */

import { Elysia } from "elysia";
import { app as appRoutes } from "./app.js";
import { createProdServer } from "./prod.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Create shared API app with real backend routes
export const app = new Elysia().use(appRoutes);


console.log("🚀 Starting production server...");

// Mount production static file handling + SPA catch-all onto the main app
// (must come after API/auth routes so specific routes take priority over /*)
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

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

export { };
