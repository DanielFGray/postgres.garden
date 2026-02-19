import http from "k6/http";
import { check } from "k6";

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

// Register a unique user and return the session cookie
export function registerUser(i) {
  const username = `loadtest_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
  const res = http.post(
    `${BASE_URL}/register`,
    JSON.stringify({
      username,
      email: `${username}@loadtest.local`,
      password: "LoadTest123!",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, { "register 200": (r) => r.status === 200 });

  // Extract session cookie from Set-Cookie header
  const cookies = res.cookies;
  const sessionCookie = cookies["session"] ? cookies["session"][0].value : null;

  return { username, sessionCookie };
}

// Login and return the session cookie
export function loginUser(id, password) {
  const res = http.post(`${BASE_URL}/login`, JSON.stringify({ id, password }), {
    headers: { "Content-Type": "application/json" },
  });

  check(res, { "login 200": (r) => r.status === 200 });

  const cookies = res.cookies;
  const sessionCookie = cookies["session"] ? cookies["session"][0].value : null;

  return sessionCookie;
}

// Build headers with optional session cookie
export function authHeaders(sessionCookie) {
  const headers = { "Content-Type": "application/json" };
  if (sessionCookie) {
    headers["Cookie"] = `session=${sessionCookie}`;
  }
  return headers;
}

// Star a playground (returns true if request succeeded)
export function starPlayground(hash, headers) {
  const res = http.post(`${BASE_URL}/api/playgrounds/${hash}/star`, null, {
    headers,
    tags: { name: "POST /api/playgrounds/:hash/star" },
  });
  return res.status === 200;
}

// Unstar a playground
export function unstarPlayground(hash, headers) {
  const res = http.del(`${BASE_URL}/api/playgrounds/${hash}/star`, null, {
    headers,
    tags: { name: "DELETE /api/playgrounds/:hash/star" },
  });
  return res.status === 200;
}

// Generate a small SQL file for playground commits
export function sampleFiles() {
  return [
    {
      path: "query.sql",
      content: `-- Load test query ${Date.now()}
CREATE TABLE test_table (
  id serial PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

INSERT INTO test_table (name)
SELECT 'row_' || i FROM generate_series(1, 100) AS i;

SELECT * FROM test_table ORDER BY created_at DESC LIMIT 10;`,
    },
  ];
}
