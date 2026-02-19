// Scenario: Authenticated user lifecycle
//
// Register -> create playground -> commit -> view commits -> fork
// Tests: session validation per request, DB write path, connection pool under transactions.
//
// Run:  k6 run k6/02-auth-flow.js

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, registerUser, authHeaders, sampleFiles } from "./helpers.js";

const errors = new Counter("errors");

export const options = {
  scenarios: {
    auth_users: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "30s", target: 50 },
        { duration: "1m", target: 100 },
        { duration: "1m", target: 100 },
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000"],
    errors: ["count<50"],
  },
};

export function setup() {
  // Nothing to set up — each VU registers its own user
  return {};
}

export default function () {
  const vuId = __VU;

  // 1. Register a new user
  const { username, sessionCookie } = registerUser(vuId);
  if (!sessionCookie) {
    errors.add(1);
    fail("registration failed — no session cookie");
  }
  const headers = authHeaders(sessionCookie);

  // 2. Verify we're logged in
  const meRes = http.get(`${BASE_URL}/api/me`, { headers });
  check(meRes, {
    "me 200": (r) => r.status === 200,
    "me has user": (r) => {
      try {
        return r.json().user != null;
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);

  // 3. Create a playground
  const createRes = http.post(
    `${BASE_URL}/api/playgrounds`,
    JSON.stringify({
      name: `loadtest-${username}`,
      message: "initial commit from load test",
      description: "Created by k6 load test",
      files: sampleFiles(),
      activeFile: "query.sql",
    }),
    { headers },
  );

  const createOk = check(createRes, {
    "create 200": (r) => r.status === 200,
    "create has hash": (r) => {
      try {
        return r.json().playground_hash != null;
      } catch {
        return false;
      }
    },
  });

  if (!createOk) {
    errors.add(1);
    return; // can't continue without a playground
  }

  const { playground_hash: hash } = createRes.json();

  sleep(0.5);

  // 4. Make a second commit
  const commitRes = http.post(
    `${BASE_URL}/api/playgrounds/${hash}/commits`,
    JSON.stringify({
      message: "second commit from load test",
      files: [
        {
          path: "query.sql",
          content: `-- Updated at ${Date.now()}\nSELECT now();`,
        },
      ],
      activeFile: "query.sql",
    }),
    { headers, tags: { name: "POST /api/playgrounds/:hash/commits" } },
  );

  check(commitRes, {
    "commit 200": (r) => r.status === 200,
  });

  sleep(0.3);

  // 5. List commits
  const listCommitsRes = http.get(`${BASE_URL}/api/playgrounds/${hash}/commits`, {
    headers,
    tags: { name: "GET /api/playgrounds/:hash/commits" },
  });
  check(listCommitsRes, {
    "list commits 200": (r) => r.status === 200,
    "has 2+ commits": (r) => {
      try {
        return r.json().length >= 2;
      } catch {
        return false;
      }
    },
  });

  // 6. Get commit detail (the latest)
  try {
    const commits = listCommitsRes.json();
    if (Array.isArray(commits) && commits.length > 0) {
      const latestId = commits[0].id;

      const detailRes = http.get(`${BASE_URL}/api/playgrounds/${hash}/commits/${latestId}`, {
        headers,
        tags: { name: "GET /api/playgrounds/:hash/commits/:id" },
      });
      check(detailRes, { "commit detail 200": (r) => r.status === 200 });

      // 7. Get diff
      const diffRes = http.get(`${BASE_URL}/api/playgrounds/${hash}/commits/${latestId}/diff`, {
        headers,
        tags: { name: "GET /api/playgrounds/:hash/commits/:id/diff" },
      });
      check(diffRes, { "diff 200": (r) => r.status === 200 });
    }
  } catch {
    // ok
  }

  sleep(0.5);

  // 8. Update playground metadata
  http.put(
    `${BASE_URL}/api/playgrounds/${hash}`,
    JSON.stringify({ description: "Updated by load test" }),
    { headers, tags: { name: "PUT /api/playgrounds/:hash" } },
  );

  sleep(1);
}
