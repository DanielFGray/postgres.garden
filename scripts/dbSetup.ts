#!/usr/bin/env bun
/**
 * Legacy db:init entrypoint. Database create/drop/roles/extensions are owned by
 * `ops dev db`; this only resets the cartridge database on the managed cluster.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("ops", ["dev", "db", "reset", "postgres_garden"], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
