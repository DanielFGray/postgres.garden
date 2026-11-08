import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { waitForWorkbench } from "./helpers";

/**
 * The ways files enter the workspace. Each must make what it loaded the
 * baseline: files the author has not touched are not changes, even when no
 * commit on the server holds them.
 */
const loads: Array<{ name: string; open: (request: APIRequestContext) => Promise<string> }> = [
  { name: "the sample", open: async () => "/" },
  {
    name: "a shared link",
    open: async () => {
      const payload = JSON.stringify({
        files: [{ path: "/workspace/shared.sql", content: "select 1;\n" }],
        activeFile: null,
      });
      return `/s/${Buffer.from(payload, "utf8").toString("base64url")}`;
    },
  },
  {
    name: "a saved playground",
    open: async (request) => {
      const created = await request.post("/api/playgrounds", {
        data: {
          name: "source_control_baseline",
          message: "first",
          files: [{ path: "/workspace/saved.sql", content: "select 1;\n" }],
        },
      });
      const { playground_hash } = await created.json();
      return `/playgrounds/${playground_hash}`;
    },
  },
];

const changesGroup = (page: Page) =>
  page.locator(".scm-view .monaco-list-row").filter({ hasText: /^Changes/ });

const showSourceControl = async (page: Page) => {
  await page.getByRole("tab", { name: /Source Control/i }).click({ timeout: 30_000 });
  // The button is the sync feature's own, so it is there once the feature
  // that keeps the Changes list has booted.
  await page.getByRole("button", { name: "Sync to Server", exact: true }).waitFor({
    timeout: 30_000,
  });
};

/** Types `text` at the end of the first cell of `fileName`'s notebook and saves it. */
const typeAndSave = async (page: Page, fileName: string, text: string) => {
  await page.getByRole("tab", { name: /Explorer/i }).click();
  await page.locator(`.monaco-list-row[aria-label="${fileName}"]`).first().click();
  const cell = page.locator(".cell-editor-container .view-lines").first();
  await cell.waitFor({ timeout: 15_000 });
  await cell.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
  await page.keyboard.press("Control+s");
};

const eraseAndSave = async (page: Page, count: number) => {
  for (let i = 0; i < count; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+s");
};

test.describe("source control", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
  });

  for (const load of loads) {
    test(`lists no changes after ${load.name} loads, and lists an edit until it is undone`, async ({
      page,
      request,
    }) => {
      await page.goto(await load.open(request));
      await waitForWorkbench(page);
      const firstFile = page.locator('.monaco-list-row[aria-label$=".sql"]').first();
      await firstFile.waitFor({ timeout: 60_000 });
      const fileName = await firstFile.getAttribute("aria-label");
      expect(fileName).not.toBeNull();

      await showSourceControl(page);
      await expect(changesGroup(page)).toHaveCount(0);

      // One edited file is one change. A load that left the baseline behind
      // would list every file it wrote here as well.
      const edit = " -- edited";
      await typeAndSave(page, fileName ?? "", edit);
      await showSourceControl(page);
      await expect(changesGroup(page)).toHaveText(/^Changes\s*1$/, { timeout: 15_000 });
      await expect(
        page.locator(".scm-view .monaco-list-row", { hasText: fileName ?? "" }),
      ).toBeVisible();

      // A file back as it was loaded is not a change.
      await page.getByRole("tab", { name: /Explorer/i }).click();
      await page.locator(".cell-editor-container .view-lines").first().click();
      await page.keyboard.press("Control+End");
      await eraseAndSave(page, edit.length);
      await showSourceControl(page);
      await expect(changesGroup(page)).toHaveCount(0, { timeout: 15_000 });
    });
  }

  test("shows a commit's diff against its parent, and moves between versions", async ({
    page,
    request,
  }) => {
    const created = await request.post("/api/playgrounds", {
      data: {
        name: "source_control_history",
        message: "first",
        files: [{ path: "/workspace/history.sql", content: "select 1;\n" }],
      },
    });
    const { playground_hash, edit_key } = await created.json();
    const second = await request.post(`/api/playgrounds/${playground_hash}/commits`, {
      headers: { "x-playground-edit-key": edit_key },
      data: {
        message: "second",
        files: [{ path: "/workspace/history.sql", content: "select 2;\n" }],
      },
    });
    expect(second.status()).toBe(200);

    await page.goto(`/playgrounds/${playground_hash}`);
    await waitForWorkbench(page);
    await page.locator('.monaco-list-row[aria-label="history.sql"]').waitFor({ timeout: 60_000 });
    await showSourceControl(page);
    // Versions count from the newest, which is Version 1.
    const versionStatus = page.locator(".statusbar-item", { hasText: /Version \d+\/\d+/ });
    await expect(versionStatus).toHaveText(/Version 1\/2/, { timeout: 15_000 });
    const historySection = page.getByRole("button", { name: "Commit History Section" });
    await historySection.click();
    await expect(historySection).toHaveAttribute("aria-expanded", "true");
    const secondRow = page
      .locator(".pane", { has: historySection })
      .locator(".monaco-list-row", { hasText: "second" });

    // The diff of a commit is what that commit changed: its parent on the
    // left, the commit on the right.
    await secondRow.click();
    await page.getByRole("option", { name: /history\.sql/ }).click({ timeout: 15_000 });
    const diff = page.locator(".monaco-diff-editor");
    await expect(diff.locator(".editor.original")).toContainText(/select\s1;/, {
      timeout: 15_000,
    });
    await expect(diff.locator(".editor.modified")).toContainText(/select\s2;/);

    await versionStatus.click();
    await page.getByRole("option", { name: /^Version 2/ }).click({ timeout: 15_000 });
    await expect(versionStatus).toHaveText(/Version 2\/2/, { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/playgrounds/${playground_hash}/commits/`));

    // The inline action passes the history item itself, not a commit id.
    await secondRow.hover();
    await secondRow.getByRole("button", { name: "Load Commit" }).click();
    await expect(versionStatus).toHaveText(/Version 1\/2/, { timeout: 30_000 });
  });
});
