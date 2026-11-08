import { test, expect, type Page } from "@playwright/test";
import { waitForWorkbench } from "./helpers";

/**
 * Saves the workspace the way the source control view does.
 *
 * The title bar has a Save button from the first paint, but the command behind
 * it belongs to the sync feature, which boots a few seconds after the
 * workbench: clicking too early does nothing at all. This button is the
 * feature's own, so waiting for it is waiting for the save to work.
 */
const saveWorkspace = async (page: Page) => {
  // The files reach the workspace a moment after the workbench does, and a
  // save before them has nothing to send. The explorer lists them once they
  // are there.
  await page.locator('.monaco-list-row[aria-label$=".sql"]').first().waitFor({ timeout: 30_000 });
  await page.getByRole("tab", { name: /Source Control/i }).click({ timeout: 30_000 });
  const sync = page.getByRole("button", { name: "Sync to Server", exact: true });
  await sync.waitFor({ timeout: 30_000 });
  await sync.click();
};

test.describe("saving without an account", () => {
  test.beforeEach(async ({ page, context }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    // The save copies the edit link, and a denied clipboard would change what
    // the notification says.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("answers an edit link, keeps it out of the address bar, and saves again with it", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await waitForWorkbench(page);

    await saveWorkspace(page);

    // The notice shows as a toast and again in the notification centre, so the
    // first of the two is the one to wait for.
    await expect(page.getByText(/only way back into this playground/i).first()).toBeVisible({
      timeout: 30_000,
    });
    // The warning waits for an answer, and the save is over while it waits.
    await expect(page.getByText(/Syncing workspace to server/i)).toHaveCount(0);

    // The playground is now this tab's URL, and the key is not: a URL copied
    // from the bar must not hand out the right to edit.
    await expect(page).toHaveURL(/\/playgrounds\/[0-9a-f]+$/, { timeout: 15_000 });
    const firstUrl = page.url();

    const editLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(editLink).toContain(`${firstUrl}#key=`);

    // Opening the link in a new tab is how the author comes back, with the
    // link as the only thing they have: nothing of the first tab carries over.
    // The key goes into that tab's storage, so its address bar is clean and
    // its save lands on the same playground rather than starting another.
    const later = await context.newPage();
    await later.setViewportSize({ width: 1400, height: 1000 });
    await later.goto(editLink);
    await waitForWorkbench(later);
    // The sync feature boots a little after the workbench, and taking the key
    // out of the bar is the first thing it does.
    await expect(later).toHaveURL(firstUrl, { timeout: 30_000 });

    await saveWorkspace(later);

    await expect(later.getByText(/file\(s\) saved/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(later).toHaveURL(firstUrl);
  });

  test("lets the link holder make their playground public, and nobody else", async ({
    request,
  }) => {
    const created = await request.post("/api/playgrounds", {
      data: {
        name: "held_by_a_key",
        message: "first",
        files: [{ path: "/workspace/a.sql", content: "select 1" }],
      },
    });
    const { playground_hash, edit_key } = await created.json();

    // Privacy is the one thing a playground cannot be created with, so the
    // dropdown is the only way to make one public - and the key is what makes
    // the dropdown theirs to use.
    const withoutKey = await request.put(`/api/playgrounds/${playground_hash}`, {
      data: { privacy: "public" },
    });
    expect(withoutKey.status()).toBe(404);

    const withKey = await request.put(`/api/playgrounds/${playground_hash}`, {
      headers: { "x-playground-edit-key": edit_key },
      data: { privacy: "public" },
    });
    expect(withKey.status()).toBe(200);
    expect((await withKey.json()).privacy).toBe("public");
  });

  test("keeps the work when the playground on screen is not theirs to write to", async ({
    page,
    request,
  }) => {
    // Someone else is holding this one: the key it was created with stays here
    // in the test and never reaches the browser.
    const created = await request.post("/api/playgrounds", {
      data: {
        name: "someone_elses",
        message: "first",
        files: [{ path: "/workspace/a.sql", content: "select 1" }],
      },
    });
    const { playground_hash } = await created.json();

    await page.goto(`/playgrounds/${playground_hash}`);
    await waitForWorkbench(page);
    // The files arrive after the workbench does, and a save before them has
    // nothing to send.
    await expect(page.getByText(/Workspace restored/i).first()).toBeVisible({ timeout: 30_000 });
    await saveWorkspace(page);

    // A visitor with no account cannot write here and has nothing to prove
    // otherwise with, so the save keeps their work in a playground of their
    // own rather than failing on one they cannot touch.
    await expect(page.getByText(/only way back into this playground/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/playgrounds\/[0-9a-f]+$/, { timeout: 15_000 });
    expect(page.url()).not.toContain(playground_hash);
  });
});
