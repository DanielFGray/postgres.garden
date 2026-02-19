/**
 * Authentication Tests
 * Tests for session validation, registration, login, and testing command endpoints
 */

import { describe, it, expect } from "bun:test";
import { treaty } from "@elysiajs/eden";
import { app as baseApp } from "./app";
import { testingServer } from "./testing";
import { rootDb } from "./db";
import { valkey } from "./valkey";

// Mount testing commands on the app
const app = baseApp.use(testingServer);

// Create type-safe client
const client = treaty(app);

// Helper to get headers from Eden treaty responses (typed as HeadersInit but is Headers at runtime)
const getHeader = (headers: HeadersInit | undefined, name: string) =>
  new Headers(headers).get(name);

// Helper to generate random strings for testing
const generateStr = (length: number) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + length);

// Helper to clean up a specific user
const cleanupUser = async (username: string) => {
  await rootDb.deleteFrom("app_public.users").where("username", "=", username).execute();
};

describe("Session Validation", () => {
  it("can register and create session", async () => {
    const username = `test_${generateStr(8)}`;
    const email = `${username}@test.com`;
    const password = "TestPassword123!";

    try {
      const { data, status, headers } = await client.register.post({
        username,
        email,
        password,
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("username", username);

      // Check session cookie was set
      const setCookie = getHeader(headers, "set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("session=");
    } finally {
      await cleanupUser(username);
    }
  });

  it("can validate session cookie on /me endpoint", async () => {
    const username = `test_${generateStr(8)}`;
    const email = `${username}@test.com`;
    const password = "TestPassword123!";

    try {
      // Register to get a session
      const registerRes = await client.register.post({
        username,
        email,
        password,
      });

      const setCookie = getHeader(registerRes.headers, "set-cookie");
      expect(setCookie).toBeTruthy();
      const sessionCookie = setCookie!.split(";")[0]!;

      // Use session to access /me
      const { data, status } = await client.me.get({
        fetch: { headers: { Cookie: sessionCookie } },
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("username", username);
    } finally {
      await cleanupUser(username);
    }
  });

  it("rejects invalid session token", async () => {
    const { status, data } = await client.me.get({
      fetch: { headers: { Cookie: "session=invalid.token.here" } },
    });

    expect(status).toBe(200);
    // When no valid session, response body is empty
    expect(data).toBeFalsy();
  });

  it("rejects expired session", async () => {
    const username = `test_${generateStr(8)}`;
    const email = `${username}@test.com`;
    const password = "TestPassword123!";

    try {
      // Register to get a session
      const registerRes = await client.register.post({
        username,
        email,
        password,
      });

      const setCookie = getHeader(registerRes.headers, "set-cookie");
      expect(setCookie).toBeTruthy();
      const sessionCookie = setCookie!.split(";")[0]!;
      const sessionId = sessionCookie.split("=")[1]!.split(".")[0]!;

      // Delete the session from Valkey to simulate expiration
      await valkey.del(`session:${sessionId}`);

      // Try to use the expired session
      const { status, data } = await client.me.get({
        fetch: { headers: { Cookie: sessionCookie } },
      });

      expect(status).toBe(200);
      // Session should be rejected, empty response
      expect(data).toBeFalsy();
    } finally {
      await cleanupUser(username);
    }
  });

  it("can login with email and create new session", async () => {
    const username = `test_${generateStr(8)}`;
    const email = `${username}@test.com`;
    const password = "TestPassword123!";

    try {
      // First register
      await client.register.post({ username, email, password });

      // Then login
      const { data, status, headers } = await client.login.post({
        id: email,
        password,
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("username", username);

      // Should have new session cookie
      const setCookie = getHeader(headers, "set-cookie");
      expect(setCookie).toBeTruthy();
      expect(setCookie).toContain("session=");
    } finally {
      await cleanupUser(username);
    }
  });

  it("can logout and invalidate session", async () => {
    const username = `test_${generateStr(8)}`;
    const email = `${username}@test.com`;
    const password = "TestPassword123!";

    try {
      // Register
      await client.register.post({ username, email, password });

      // Login to get a fresh session
      const loginRes = await client.login.post({
        id: username,
        password,
      });

      const setCookie = getHeader(loginRes.headers, "set-cookie");
      expect(setCookie).toBeTruthy();
      const sessionCookie = setCookie!.split(";")[0]!;

      // Logout
      const logoutRes = await client.logout.post(
        {},
        { fetch: { headers: { Cookie: sessionCookie } } },
      );
      expect(logoutRes.status).toBe(200);

      // Try to use the old session
      const meRes = await client.me.get({
        fetch: { headers: { Cookie: sessionCookie } },
      });

      // Session should be invalid after logout
      expect(meRes.data).toBeFalsy();
    } finally {
      await cleanupUser(username);
    }
  });
});

describe("Testing Command Endpoints", () => {
  it("should clear test users successfully", async () => {
    const username = `test_cleartest_${generateStr(6)}`;

    // Clean up first in case of previous failed run
    await cleanupUser(username);

    // Create a test user with the test% prefix
    await rootDb
      .insertInto("app_public.users")
      .values({
        username,
        is_verified: true,
      })
      .execute();

    const { data, status } = await client.api.testingCommand.clearTestUsers.get();

    expect(status).toBe(200);
    expect(data).toHaveProperty("success", true);

    // Verify user was deleted
    const user = await rootDb
      .selectFrom("app_public.users")
      .where("username", "=", username)
      .selectAll()
      .executeTakeFirst();

    expect(user).toBeUndefined();
  });

  it("should create a test user", async () => {
    const username = `testuser_${generateStr(6)}`;
    const email = `${username}@example.com`;

    try {
      const { data, status } = await client.api.testingCommand.createUser.get({
        query: {
          username,
          email,
          verified: "true",
          password: "TestPassword123",
        },
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("user");
      expect(data).toHaveProperty("user.username", username);
      expect(data).toHaveProperty("user.is_verified", true);
      expect(data).toHaveProperty("userEmailId");
    } finally {
      await cleanupUser(username);
    }
  });

  it("should get user secrets", async () => {
    const username = `testuser_${generateStr(6)}`;

    try {
      // First create a user
      await client.api.testingCommand.createUser.get({
        query: { username, password: "TestPassword456" },
      });

      // Then get their secrets
      const { data, status } = await client.api.testingCommand.getUserSecrets.get({
        query: { username },
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("user_id");
      expect(data).toHaveProperty("password_hash");
    } finally {
      await cleanupUser(username);
    }
  });

  it("should verify a user", async () => {
    const username = `testuser_${generateStr(6)}`;

    try {
      // Create unverified user
      await client.api.testingCommand.createUser.get({
        query: { username, verified: "false" },
      });

      // Verify the user
      const { data, status } = await client.api.testingCommand.verifyUser.get({
        query: { username },
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("success", true);

      // Verify it worked in DB
      const user = await rootDb
        .selectFrom("app_public.users")
        .where("username", "=", username)
        .select("is_verified")
        .executeTakeFirst();

      expect(user?.is_verified).toBe(true);
    } finally {
      await cleanupUser(username);
    }
  });

  it("should login and set session cookie via testing endpoint", async () => {
    const username = `testlogin_${generateStr(6)}`;

    try {
      const { status, headers } = await client.api.testingCommand.login.get({
        query: { username, verified: "true", redirectTo: "/" },
        fetch: { redirect: "manual" },
      });

      expect(status).toBe(302);
      expect(getHeader(headers, "location")).toBe("/");
      expect(getHeader(headers, "set-cookie")).toContain("session=");
    } finally {
      await cleanupUser(username);
    }
  });

  it("should register a new user via testing API", async () => {
    const username = `testuser_${generateStr(8)}`;
    const email = `${username}@example.com`;

    try {
      const { status, headers } = await client.api.testingCommand.register.post(
        {
          username,
          email,
          password: "TestPassword123!",
        },
        { fetch: { redirect: "manual" } },
      );

      expect(status).toBe(302);
      expect(getHeader(headers, "location")).toBe("/");
      expect(getHeader(headers, "set-cookie")).toContain("session=");
    } finally {
      await cleanupUser(username);
    }
  });

  it("should login via testing API and get session cookie", async () => {
    const username = `logintest_${generateStr(8)}`;
    const email = `${username}@example.com`;
    const password = "TestPassword123!";

    try {
      // First register
      await client.api.testingCommand.register.post(
        { username, email, password },
        { fetch: { redirect: "manual" } },
      );

      // Then login
      const { status, headers } = await client.api.testingCommand.loginPost.post(
        { id: username, password },
        { fetch: { redirect: "manual" } },
      );

      expect(status).toBe(302);
      expect(getHeader(headers, "location")).toBe("/");
      expect(getHeader(headers, "set-cookie")).toContain("session=");
    } finally {
      await cleanupUser(username);
    }
  });

  it("should access /me endpoint with valid session from testing login", async () => {
    const username = `metest_${generateStr(8)}`;
    const email = `${username}@example.com`;
    const password = "TestPassword123!";

    try {
      // Register and login via testing endpoints
      await client.api.testingCommand.register.post(
        { username, email, password },
        { fetch: { redirect: "manual" } },
      );

      const loginRes = await client.api.testingCommand.loginPost.post(
        { id: username, password },
        { fetch: { redirect: "manual" } },
      );

      const setCookie = getHeader(loginRes.headers, "set-cookie");
      expect(setCookie).toBeTruthy();

      const sessionCookie = setCookie!.split(";")[0]!;

      // Access /me with the session cookie
      const { data, status } = await client.me.get({
        fetch: { headers: { Cookie: sessionCookie } },
      });

      expect(status).toBe(200);
      expect(data).toHaveProperty("username", username);
    } finally {
      await cleanupUser(username);
    }
  });

  it("should logout and clear session from testing login", async () => {
    const username = `logouttest_${generateStr(8)}`;
    const email = `${username}@example.com`;
    const password = "TestPassword123!";

    try {
      // Register and login via testing endpoints
      await client.api.testingCommand.register.post(
        { username, email, password },
        { fetch: { redirect: "manual" } },
      );

      const loginRes = await client.api.testingCommand.loginPost.post(
        { id: username, password },
        { fetch: { redirect: "manual" } },
      );

      const setCookie = getHeader(loginRes.headers, "set-cookie");
      expect(setCookie).toBeTruthy();

      const sessionCookie = setCookie!.split(";")[0]!;

      // Logout
      const logoutRes = await client.logout.post(
        {},
        { fetch: { headers: { Cookie: sessionCookie } } },
      );
      expect(logoutRes.status).toBe(200);

      // Try to access /me with old session (should fail)
      const meRes = await client.me.get({
        fetch: { headers: { Cookie: sessionCookie } },
      });

      // When no user is authenticated, /me returns empty body
      expect(meRes.status).toBe(200);
      expect(meRes.data).toBeFalsy();
    } finally {
      await cleanupUser(username);
    }
  });
});
