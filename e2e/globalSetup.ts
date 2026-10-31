import { request } from "@playwright/test";
import { serverCommand } from "./helpers";

/**
 * Clears the users left behind by earlier runs, once, before any worker starts.
 *
 * The reset is global: it deletes every user whose name starts with "test" and
 * every session in Valkey. Run from a `beforeAll`, which Playwright runs once
 * per worker and again after a worker restarts, it logs out the users the other
 * workers are in the middle of using. Here it cannot.
 */
export default async function globalSetup() {
  const context = await request.newContext();
  await serverCommand(context, "clearTestUsers");
  await context.dispose();
}
