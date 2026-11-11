import { test, expect } from "@playwright/test";
import {
  addNotebookCodeCell,
  authPanelFrame,
  authStatusItem,
  createFileFromExplorer,
  firstNotebookEditor,
  forgotPassword,
  login,
  loginWithPassword,
  notebookOutputFrame,
  notebookResultTable,
  openAccountSettings,
  openExplorerFile,
  openSignInPanel,
  registerWithPassword,
  mailedLink,
  serverCommand,
  testingRegister,
  waitForWorkbench,
  runAllNotebookCells,
} from "./helpers";

test.describe("workbench basics", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
  });

  test("no duplicate monaco-vscode-api loads", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    await login(page, { verified: true });
    await waitForWorkbench(page);

    const dupeErrors = errors.filter((e) =>
      /Another version of monaco-vscode-api has already been loaded/.test(e),
    );
    expect(dupeErrors).toEqual([]);
  });

  test("logs in with test helper", async ({ page }) => {
    const session = await login(page, { verified: true });

    await waitForWorkbench(page);
    await expect(authStatusItem(page)).toContainText(session.username, { timeout: 15_000 });
  });

  test("registers with username and password through auth panel", async ({ page }) => {
    const session = await registerWithPassword(page);

    await waitForWorkbench(page);
    await expect(authStatusItem(page)).toContainText(session.username, { timeout: 15_000 });
  });

  test("shows duplicate username error during register", async ({ page, request }) => {
    const username = `test_${Date.now().toString(36)}`;
    const email = `${username}@example.com`;
    const password = "TestPassword123!";

    const response = await testingRegister(request, { username, email, password });
    expect(response.status()).toBe(302);

    const auth = await openSignInPanel(page);
    await auth.locator('[data-pw="nav-register"]').click({ force: true });
    await auth.locator('[data-pw="register-form"]').waitFor({ timeout: 10_000 });
    await auth.locator('[data-pw="register-username-input"]').fill(username);
    await auth.locator('[data-pw="register-email-input"]').fill(`dupe_${email}`);
    await auth.locator('[data-pw="register-password-input"]').fill(password);
    await auth.locator('[data-pw="register-confirm-password-input"]').fill(password);
    await auth.locator('[data-pw="register-submit-button"]').click();

    await expect(auth.locator('[data-pw="register-error"]')).toContainText(
      /username is already taken/i,
    );
  });

  test("requires register form fields", async ({ page }) => {
    const auth = await openSignInPanel(page);
    await auth.locator('[data-pw="nav-register"]').click({ force: true });
    await auth.locator('[data-pw="register-form"]').waitFor({ timeout: 10_000 });
    await auth.locator('[data-pw="register-submit-button"]').click();

    await expect(auth.locator('[data-pw="register-error"]')).toContainText(/password must/i);
  });

  test("verify email deep link verifies email", async ({ page, request }) => {
    const username = `test_${Date.now().toString(36)}`;
    await serverCommand(request, "createUser", { username });
    const verifyLink = await mailedLink(request, `${username}@example.com`, "/verify");

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto(verifyLink);

    await expect(page.locator("#workbench-container")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: /^sign in$/i }).click({ force: true });
    const auth = await authPanelFrame(page);
    await expect(auth.locator('[data-pw="email-verified"]')).toBeVisible({ timeout: 15_000 });
    const relevantErrors = errors.filter(
      (error) => !/ws:\/\/localhost:\d+.*ERR_CONNECTION_REFUSED|^Canceled$/i.test(error),
    );
    expect(relevantErrors).toEqual([]);
  });

  test("shows login error on bad password and recovers", async ({ page, request }) => {
    const username = `test_${Date.now().toString(36)}`;
    const password = "MyPassword1";

    await serverCommand(request, "createUser", {
      username,
      verified: "true",
      password,
    });

    const auth = await loginWithPassword(page, {
      id: username,
      password: `${password}!`,
    });

    await expect(auth.locator('[data-pw="login-error"]')).toContainText(
      /invalid username or password|decode error/i,
    );

    await auth.locator('[data-pw="login-password-input"]').fill(password);
    await auth.locator('[data-pw="login-submit-button"]').click();

    await waitForWorkbench(page);
    await expect(authStatusItem(page)).toContainText(username, { timeout: 15_000 });
  });

  test("can request reset link then reset password and log in", async ({ page, request }) => {
    const username = `test_${Date.now().toString(36)}`;
    const oldPassword = "OldPassword123!";
    const newPassword = "NewPassword123!";

    await serverCommand(request, "createUser", {
      username,
      verified: "true",
      password: oldPassword,
    });

    let auth = await forgotPassword(page, `${username}@example.com`);
    await expect(auth.locator('[data-pw="forgot-password-sent"]')).toBeVisible({ timeout: 15_000 });

    await page.goto(await mailedLink(request, `${username}@example.com`, "/reset"));
    await expect(page.locator("#workbench-container")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: /^sign in$/i }).click({ force: true });
    auth = await authPanelFrame(page);

    await auth.locator('[data-pw="reset-password-input"]').fill(newPassword);
    await auth.locator('[data-pw="reset-confirm-password-input"]').fill(newPassword);
    await auth.locator('[data-pw="reset-submit-button"]').click();

    await expect(auth.locator('[data-pw="password-reset-success"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press("Control+F4");
    await loginWithPassword(page, { id: username, password: newPassword });
    await waitForWorkbench(page);
    await expect(authStatusItem(page)).toContainText(username, { timeout: 15_000 });
  });

  test("can add an email, verify it, make it primary, and delete original email", async ({
    page,
    request,
  }) => {
    const username = `test_${Date.now().toString(36)}`;
    const originalEmail = `${username}@example.com`;
    const originalSlug = originalEmail
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();
    const newEmail = `new_${username}@example.com`;
    const newSlug = newEmail
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase();

    await login(page, { username, verified: true, redirectTo: "/" });
    await waitForWorkbench(page);

    let settings = await openAccountSettings(page);
    await settings.locator('[data-pw="account-nav-emails"]').click();
    await settings.locator('[data-pw="emails-section"]').waitFor({ timeout: 15_000 });

    let originalEmailItem = settings.locator(`[data-pw="email-settings-item-${originalSlug}"]`);
    await expect(originalEmailItem).toContainText(originalEmail);
    await expect(
      originalEmailItem.locator('[data-pw="email-settings-indicator-unverified"]'),
    ).toHaveCount(0);

    await settings.locator('[data-pw="settings-email-input"]').fill(originalEmail);
    await settings.locator('[data-pw="settings-email-submit"]').click();
    await expect(settings.locator('[data-pw="email-settings-error"]')).toContainText(/already/i);

    await settings.locator('[data-pw="settings-email-input"]').fill(newEmail);
    await settings.locator('[data-pw="settings-email-submit"]').click();

    let newEmailItem = settings.locator(`[data-pw="email-settings-item-${newSlug}"]`);
    await expect(newEmailItem).toContainText(newEmail, { timeout: 15_000 });
    await expect(
      newEmailItem.locator('[data-pw="email-settings-indicator-unverified"]'),
    ).toBeVisible();

    await page.goto(await mailedLink(request, newEmail, "/verify"));
    await expect(page.locator("#workbench-container")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: /^sign in$/i }).click({ force: true });
    const auth = await authPanelFrame(page);
    await expect(auth.locator('[data-pw="email-verified"]')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Control+F4");

    settings = await openAccountSettings(page);
    await settings.locator('[data-pw="account-nav-emails"]').click();
    originalEmailItem = settings.locator(`[data-pw="email-settings-item-${originalSlug}"]`);
    newEmailItem = settings.locator(`[data-pw="email-settings-item-${newSlug}"]`);
    await expect(
      newEmailItem.locator('[data-pw="email-settings-indicator-unverified"]'),
    ).toHaveCount(0);
    await expect(
      newEmailItem.locator('[data-pw="email-settings-button-makeprimary"]'),
    ).toBeVisible();

    await newEmailItem.locator('[data-pw="email-settings-button-makeprimary"]').click();
    await expect(newEmailItem.locator('[data-pw="email-settings-indicator-primary"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(newEmailItem.locator('[data-pw="email-settings-button-makeprimary"]')).toHaveCount(
      0,
    );
    await expect(
      originalEmailItem.locator('[data-pw="email-settings-indicator-primary"]'),
    ).toHaveCount(0);

    await originalEmailItem.locator('[data-pw="email-settings-button-delete"]').click();
    await expect(originalEmailItem).toHaveCount(0, { timeout: 15_000 });
  });

  test("user can change password and then sign in with the new password", async ({ page }) => {
    const username = `test_${Date.now().toString(36)}`;
    const oldPassword = "oldpassword!";
    const newPassword = "newpassword!";

    await login(page, { username, verified: true, password: oldPassword, redirectTo: "/" });
    await waitForWorkbench(page);

    const settings = await openAccountSettings(page);
    await settings.locator('[data-pw="account-nav-security"]').click();
    await settings.locator('[data-pw="security-section"]').waitFor({ timeout: 15_000 });

    await settings.locator('[data-pw="settings-oldPassword-input"]').fill(`${oldPassword}x`);
    await settings.locator('[data-pw="settings-password-input"]').fill(newPassword);
    await settings.locator('[data-pw="settings-confirmPassword-input"]').fill(newPassword);
    await settings.locator('[data-pw="settings-change-password-submit"]').click();
    await expect(settings.locator('[data-pw="settings-change-password-error"]')).toContainText(
      /incorrect|invalid/i,
    );

    await settings.locator('[data-pw="settings-oldPassword-input"]').fill(oldPassword);
    await settings.locator('[data-pw="settings-change-password-submit"]').click();
    await expect(settings.locator('[data-pw="settings-change-password-success"]')).toContainText(
      /password (changed|set) successfully/i,
      { timeout: 15_000 },
    );

    await page.keyboard.press("Control+F4");
    await page.context().clearCookies();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWorkbench(page);

    let auth = await loginWithPassword(page, { id: username, password: oldPassword });
    await expect(auth.locator('[data-pw="login-error"]')).toContainText(
      /invalid username or password/i,
      { timeout: 15_000 },
    );

    auth = await loginWithPassword(page, { id: username, password: newPassword });
    await waitForWorkbench(page);
    await expect(authStatusItem(page)).toContainText(username, { timeout: 15_000 });
  });

  test("sends account deletion request and deletes account from email token", async ({
    page,
    request,
  }) => {
    const username = `test_${Date.now().toString(36)}`;
    const password = "MyPassword1";

    await login(page, { username, password, verified: true, redirectTo: "/" });
    await waitForWorkbench(page);

    let settings = await openAccountSettings(page);
    await settings.locator('[data-pw="account-nav-danger-zone"]').click();
    await settings.locator('[data-pw="danger-zone-section"]').waitFor({ timeout: 15_000 });

    await settings.locator('[data-pw="account-delete-request-button"]').click();
    await settings.locator('[data-pw="account-delete-confirm-input"]').fill(username);
    await settings.locator('[data-pw="account-delete-request-confirm-button"]').click();
    await expect(settings.locator('[data-pw="account-delete-request-sent"]')).toContainText(
      /confirmation email/i,
      { timeout: 15_000 },
    );

    const deleteLink = await mailedLink(request, `${username}@example.com`, "/settings");
    await page.goto(deleteLink, {
      waitUntil: "domcontentloaded",
    });
    await waitForWorkbench(page);

    settings = await openAccountSettings(page);
    await settings.locator('[data-pw="account-nav-danger-zone"]').click();
    await expect(settings.locator('[data-pw="account-delete-confirm-button"]')).toBeVisible({
      timeout: 15_000,
    });
    // Wait for the DELETE itself, not for the URL. The workbench strips the
    // token from the URL while it boots (src/features/auth.ts), so "/" with no
    // fragment is already true before the click: a wait on the URL
    // resolves while the request is still in flight, and the login below needs
    // the deletion to have finished.
    const deletion = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/me" && response.request().method() === "DELETE",
      { timeout: 15_000 },
    );
    await settings.locator('[data-pw="account-delete-confirm-button"]').click();
    expect((await deletion).status()).toBe(200);

    const deletedAccountLogin = await request.post("/api/auth/login", {
      data: { id: username, password },
    });
    expect(deletedAccountLogin.status()).toBe(401);
  });

  test("can create file and execute notebook", async ({ page }) => {
    await login(page, { verified: true });
    await waitForWorkbench(page);

    await expect(page.getByRole("treeitem", { name: /workspace/i })).toBeVisible({
      timeout: 10_000,
    });

    await createFileFromExplorer(page, "test.sql");

    await openExplorerFile(page, "test.sql");
    await expect(page.getByRole("button", { name: "SQL Notebook" }).first()).toBeVisible({
      timeout: 10_000,
    });

    await addNotebookCodeCell(page);

    const editor = await firstNotebookEditor(page);
    await editor.click();
    await page.keyboard.insertText("SELECT 1 AS test_column;");

    await runAllNotebookCells(page);

    await expect(notebookResultTable(page)).toContainText("test_column", { timeout: 20_000 });
  });

  test("shows the Postgres message when a notebook query fails", async ({ page }) => {
    await login(page, { verified: true });
    await waitForWorkbench(page);

    await expect(page.getByRole("treeitem", { name: /workspace/i })).toBeVisible({
      timeout: 10_000,
    });

    await createFileFromExplorer(page, "broken.sql");

    await openExplorerFile(page, "broken.sql");
    await expect(page.getByRole("button", { name: "SQL Notebook" }).first()).toBeVisible({
      timeout: 10_000,
    });

    await addNotebookCodeCell(page);

    const editor = await firstNotebookEditor(page);
    await editor.click();
    await page.keyboard.insertText("SELECT '<b>x</b>'::int;");

    await runAllNotebookCells(page);

    await expect(
      notebookOutputFrame(page).getByText('invalid input syntax for type integer: "<b>x</b>"'),
    ).toBeVisible({ timeout: 20_000 });
  });
});
