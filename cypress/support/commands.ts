// ***********************************************
// For more comprehensive examples of custom
// commands please read more here:
// https://on.cypress.io/custom-commands
// ***********************************************
//
//
// -- This is a parent command --
// Cypress.Commands.add("login", (email, password) => { ... })
//
//
// -- This is a child command --
// Cypress.Commands.add("drag", { prevSubject: 'element'}, (subject, options) => { ... })
//
//
// -- This is a dual command --
// Cypress.Commands.add("dismiss", { prevSubject: 'optional'}, (subject, options) => { ... })
//
//
// -- This is will overwrite an existing command --
// Cypress.Commands.overwrite("visit", (originalFn, url, options) => { ... })

/// <reference types="cypress" />

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chainable<Subject = any> = Cypress.Chainable<Subject>;

type User = {
  id: string;
  username: string;
  name: string;
  is_admin: boolean;
  is_verified: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCy(cyName: string): Chainable<any> {
  return cy.get(`[data-cy=${cyName}]`);
}

/**
 * Deletes all users with username starting 'test_'.
 */
function serverCommand(command: "clearTestUsers"): Chainable<{
  success: true;
}>;

/**
 * Deletes all organizations with slug starting 'test'.
 */
function serverCommand(command: "clearTestOrganizations"): Chainable<{
  success: true;
}>;

/**
 * Creates a verified or unverified user, bypassing all safety checks.
 * Redirects to `next`.
 *
 * Default values:
 *
 * - username: `testuser`
 * - email: `${username}@example.com`
 * - verified: false
 * - name: `${username}`
 * - password: `TestUserPassword`
 * - next: `/`
 */
function serverCommand(
  command: "createUser",
  payload: {
    username?: string;
    email?: string;
    verified?: 'true' | 'false';
    name?: string;
    password?: string;
    next?: string;
  },
): Chainable<{
  user: User;
  userEmailId: string;
  verificationToken: string | null;
}>;

/**
 * Gets the secrets for the specified User, allowing Cypress to perform User
 * validation. If unspecified, User defaults to `testuser@example.com`.
 */
function serverCommand(
  command: "getUserSecrets",
  payload?: { username?: string },
): Chainable<{
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
}>;

/**
 * Gets the secrets for the specified email, allowing Cypress to perform email
 * validation. If unspecified, email defaults to `testuser@example.com`.
 */
function serverCommand(
  command: "getEmailSecrets",
  payload?: { email?: string },
): Chainable<{
  user_email_id: string;
  verification_token: string | null;
}>;

/**
 * Marks the given user as verified. Used for testing live user subscription
 * updates.
 */
function serverCommand(
  command: "verifyUser",
  payload?: { username?: string },
): Chainable<{ success: true }>;

// The actual implementation of the 'serverCommand' function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serverCommand(command: string, payload?: Record<string, string>): Chainable<any> {
  const endpoint = `/api/testingCommand/${command}`
  const params = payload ? new URLSearchParams(Object.entries(payload)).toString() : "";
  const url = params ? [endpoint, params].join('?') : endpoint;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return cy.request("GET", url).its("body");
}

function login(payload?: {
  redirectTo?: string;
  username?: string;
  name?: string;
  verified?: boolean;
  password?: string | null;
  orgs?: [[string, string] | [string, string, boolean]];
}): Chainable<Cypress.AUTWindow> {
  // Generate a unique username if not provided to avoid conflicts
  // Constraint: 2-64 chars, must start with letter, can contain letters/numbers/underscore/hyphen
  const timestamp = Date.now().toString(36); // Base36 is shorter (~11 chars)
  const random = Math.random().toString(36).substring(2, 6); // 4 chars
  const uniqueUsername = payload?.username ?? `test_${timestamp}${random}`; // ~36 chars

  const params = new URLSearchParams();
  if (uniqueUsername) params.set("username", uniqueUsername);
  if (payload?.name) params.set("name", payload.name);
  if (payload?.verified !== undefined) params.set("verified", String(payload.verified));
  if (payload?.password) params.set("password", payload.password);
  if (payload?.redirectTo) params.set("redirectTo", payload.redirectTo);
  if (payload?.orgs) params.set("orgs", JSON.stringify(payload.orgs));

  const queryString = params.toString();
  return cy.visit(
    `/api/testingCommand/login${queryString ? `?${queryString}` : ""}`,
  );
}

// ============================================
// VSCode Workbench Testing Commands
// ============================================

/**
 * Waits for the VSCode workbench to be fully initialized and ready.
 * Returns the workbench container element for chaining.
 *
 * @example
 * cy.visit('/');
 * cy.waitForWorkbench().within(() => { ... });
 */
function waitForWorkbench() {
  // eslint-disable-next-line cypress/unsafe-to-chain-command
  return cy.get('#workbench-container', { timeout: 30000 })
    .should('exist')
    .within(() => {
      cy.get('footer.statusbar', { timeout: 30000 }).should('exist');
    })
    .then(() => cy.get('#workbench-container'));
}

/**
 * Waits for a notification message to appear in the workbench.
 *
 * @param message - The message text or regex pattern to match
 * @param options - Cypress get options (e.g., timeout)
 *
 * @example
 * cy.waitForNotification('Workspace synced');
 * cy.waitForNotification(/synced/i, { timeout: 15000 });
 */
function waitForNotification(
  message: string | RegExp,
  options?: Partial<Cypress.Loggable & Cypress.Timeoutable>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Chainable<any> {
  return cy.contains(message, options);
}

// Register all commands
Cypress.Commands.add("getCy", getCy);
Cypress.Commands.add("serverCommand", serverCommand);
Cypress.Commands.add("login", login);

// VSCode workbench commands
Cypress.Commands.add("waitForWorkbench", waitForWorkbench);
Cypress.Commands.add("waitForNotification", waitForNotification);

export { }; // Make this a module so we can `declare global`

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      getCy: typeof getCy;
      serverCommand: typeof serverCommand;
      login: typeof login;

      waitForWorkbench: typeof waitForWorkbench;
      waitForNotification: typeof waitForNotification;
    }
  }
}
