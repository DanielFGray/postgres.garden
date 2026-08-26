import {
  expect,
  type APIRequestContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";

type User = {
  id: string;
  username: string;
  name: string;
  is_admin: boolean;
  is_verified: boolean;
};

const BASE_URL = "http://localhost:3000";

type LoginOptions = {
  redirectTo?: string;
  username?: string;
  name?: string;
  verified?: boolean;
  password?: string | null;
  orgs?: [[string, string] | [string, string, boolean]];
};

// --- Server Commands ---

type ServerCommandMap = {
  clearTestUsers: { success: true };
  clearTestOrganizations: { success: true };
  createUser: {
    user: User;
    userEmailId: string;
    verificationToken: string | null;
  };
  getUserSecrets: {
    user_id: string;
    password_hash: string | null;
    last_login_at: string;
    failed_password_attempts: number;
    first_failed_password_attempt: string | null;
    reset_password_token: string | null;
    reset_password_token_generated: string | null;
    failed_reset_password_attempts: number;
    first_failed_reset_password_attempt: string | null;
    delete_account_token: string | null;
    delete_account_token_generated: string | null;
  };
  getEmailSecrets: {
    user_email_id: string;
    verification_token: string | null;
  };
  verifyUser: { success: true };
};

export async function serverCommand<K extends keyof ServerCommandMap>(
  request: APIRequestContext,
  command: K,
  payload?: Record<string, string>,
): Promise<ServerCommandMap[K]> {
  const params = payload ? `?${new URLSearchParams(Object.entries(payload)).toString()}` : "";
  const response = await request.get(`${BASE_URL}/api/testing/${command}${params}`);
  return response.json();
}

// --- Login ---

export async function login(page: Page, payload?: LoginOptions) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  const uniqueUsername = payload?.username ?? `test_${timestamp}${random}`;

  const params = new URLSearchParams();
  if (uniqueUsername) params.set("username", uniqueUsername);
  if (payload?.name) params.set("name", payload.name);
  if (payload?.verified !== undefined) params.set("verified", String(payload.verified));
  if (payload?.password) params.set("password", payload.password);
  if (payload?.redirectTo) params.set("redirectTo", payload.redirectTo);
  if (payload?.orgs) params.set("orgs", JSON.stringify(payload.orgs));

  const queryString = params.toString();
  await page.goto(`${BASE_URL}/api/testing/login${queryString ? `?${queryString}` : ""}`, {
    waitUntil: "domcontentloaded",
  });

  return { username: uniqueUsername };
}

export async function testingRegister(
  request: APIRequestContext,
  payload: {
    username: string;
    email: string;
    password: string;
    redirectTo?: string;
  },
) {
  return request.post(`${BASE_URL}/api/testing/register`, {
    data: payload,
    maxRedirects: 0,
  });
}

// --- Workbench Helpers ---

export function getPw(page: Page, testId: string): Locator {
  return page.locator(`[data-pw="${testId}"]`);
}

async function ensureWorkbenchPage(page: Page) {
  if (!page.url() || page.url() === "about:blank") {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  }
}

export async function openSignInPanel(page: Page) {
  await ensureWorkbenchPage(page);
  await waitForWorkbench(page);
  const signInItem = page
    .getByRole("button", { name: /account sign in, click to sign in/i })
    .first();
  await signInItem.waitFor({ timeout: 15_000 });
  await signInItem.click();
  return authPanelFrame(page);
}

export function authStatusItem(page: Page) {
  return page
    .getByRole("button", { name: /account .*signed in as .*click for account options/i })
    .first();
}

async function focusAuthTab(page: Page) {
  const authTab = page.getByRole("tab", { name: /^sign in$/i }).first();
  if (await authTab.count()) {
    await authTab.click({ force: true });
  }
}

export async function authPanelFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 15_000;

  const frameHasAuthUi = async (frame: Frame) => {
    return Boolean(
      (await frame.locator('[data-pw="auth-panel"]').count()) ||
      (await frame.locator('[data-pw="login-form"]').count()) ||
      (await frame.locator('[data-pw="register-form"]').count()) ||
      (await frame.locator('[data-pw="email-verified"]').count()),
    );
  };

  while (Date.now() < deadline) {
    await focusAuthTab(page);

    const candidateFrames = page
      .frames()
      .filter((frame) => {
        const url = frame.url();
        return url.includes("fake.html") || url.includes("index.html?id=");
      })
      .sort((a, b) => b.url().length - a.url().length);

    for (const frame of candidateFrames) {
      try {
        if (await frameHasAuthUi(frame)) {
          return frame;
        }
      } catch {
        // Keep polling while the webview frame initializes.
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error("Auth panel frame not found");
}

export async function registerWithPassword(
  page: Page,
  payload?: {
    username?: string;
    email?: string;
    password?: string;
  },
) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  const username = payload?.username ?? `test_${timestamp}${random}`;
  const email = payload?.email ?? `${username}@example.com`;
  const password = payload?.password ?? "TestPassword123!";

  const auth = await openSignInPanel(page);
  await auth.locator('[data-pw="login-form"]').waitFor({ timeout: 10_000 });
  await auth.locator('[data-pw="nav-register"]').waitFor({ timeout: 10_000 });
  await auth.locator('[data-pw="nav-register"]').click({ force: true });
  await auth.locator('[data-pw="register-form"]').waitFor({ timeout: 10_000 });
  await auth.locator('[data-pw="register-username-input"]').fill(username);
  await auth.locator('[data-pw="register-email-input"]').fill(email);
  await auth.locator('[data-pw="register-password-input"]').fill(password);
  await auth.locator('[data-pw="register-confirm-password-input"]').fill(password);
  await auth.locator('[data-pw="register-submit-button"]').click();
  await expect(authStatusItem(page)).toContainText(username, { timeout: 15_000 });

  return { username, email, password };
}

export async function loginWithPassword(
  page: Page,
  payload: {
    id: string;
    password: string;
  },
) {
  const auth = await openSignInPanel(page);
  await auth.locator('[data-pw="login-form"]').waitFor({ timeout: 10_000 });
  await auth.locator('[data-pw="login-id-input"]').fill(payload.id);
  await auth.locator('[data-pw="login-password-input"]').fill(payload.password);
  await auth.locator('[data-pw="login-submit-button"]').click();
  return auth;
}

export async function forgotPassword(page: Page, email: string) {
  const auth = await openSignInPanel(page);
  await auth.locator('[data-pw="forgot-password-link"]').click();
  await auth.locator('[data-pw="forgot-password-form"]').waitFor({ timeout: 10_000 });
  await auth.locator('[data-pw="forgot-email-input"]').fill(email);
  await auth.locator('[data-pw="forgot-submit-button"]').click();
  return auth;
}

export async function openAccountSettings(page: Page) {
  await waitForWorkbench(page);
  await authStatusItem(page).click();
  await page.getByRole("option", { name: /account settings/i }).click();
  return accountSettingsFrame(page);
}

async function focusAccountSettingsTab(page: Page) {
  const accountTab = page.getByRole("tab", { name: /^account settings$/i }).first();
  if (await accountTab.count()) {
    await accountTab.click({ force: true });
  }
}

export async function accountSettingsFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    await focusAccountSettingsTab(page);

    const candidateFrames = page
      .frames()
      .filter((frame) => {
        const url = frame.url();
        return url.includes("fake.html") || url.includes("index.html?id=");
      })
      .sort((a, b) => b.url().length - a.url().length);

    for (const frame of candidateFrames) {
      try {
        if (await frame.locator('[data-pw="account-settings-root"]').count()) {
          return frame;
        }
      } catch {
        // continue polling during init
      }
    }

    await page.waitForTimeout(200);
  }

  throw new Error("Account settings frame not found");
}

export async function waitForWorkbench(page: Page) {
  await page.locator("#workbench-container").waitFor({ timeout: 30_000 });
  await page.locator("#workbench-container footer.statusbar").waitFor({ timeout: 30_000 });

  return page.locator("#workbench-container");
}

export async function waitForNotification(
  page: Page,
  message: string | RegExp,
  options?: { timeout?: number },
) {
  const locator = page.getByText(message, { exact: typeof message === "string" });
  await expect(locator).toBeVisible({ timeout: options?.timeout ?? 15_000 });
  return locator;
}

export async function createFileFromExplorer(page: Page, fileName: string) {
  await waitForWorkbench(page);
  await page.locator('.codicon-new-file[aria-label^="New File"]').first().click({ force: true });
  await page.locator('input[aria-label^="Type file name"]').fill(fileName);
  await page.keyboard.press("Enter");
}

export async function openExplorerFile(page: Page, fileName: string) {
  await page.locator(".monaco-list-row").filter({ hasText: fileName }).dblclick();
}

export async function addNotebookCodeCell(page: Page) {
  await page
    .getByRole("button", { name: /Add Code Cell/i })
    .last()
    .click({ force: true });
}

export async function firstNotebookEditor(page: Page) {
  const editor = page.locator(".cell-editor-container .monaco-editor").last();
  await editor.waitFor({ timeout: 10_000 });
  return editor;
}

export async function runAllNotebookCells(page: Page) {
  await page.getByRole("button", { name: "Run All", exact: true }).click();
}
