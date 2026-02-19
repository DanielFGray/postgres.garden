// Scenario: Realistic mixed workload
//
// 70% anonymous browsing, 20% authenticated CRUD, 10% user profile views.
// This is the closest simulation to "what happens when it goes viral".
//
// Run:  k6 run k6/03-mixed-workload.js

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, registerUser, authHeaders, sampleFiles } from "./helpers.js";

const errors = new Counter("errors");
const browseDuration = new Trend("browse_duration", true);
const authDuration = new Trend("auth_action_duration", true);
const profileDuration = new Trend("profile_duration", true);

export const options = {
  scenarios: {
    // Anonymous browsers — the bulk of traffic
    browsers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 50 },
        { duration: "30s", target: 150 },
        { duration: "2m", target: 300 },
        { duration: "1m", target: 300 },
        { duration: "15s", target: 0 },
      ],
      exec: "browse",
    },

    // Authenticated users creating/editing
    creators: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 20 },
        { duration: "2m", target: 50 },
        { duration: "1m", target: 50 },
        { duration: "15s", target: 0 },
      ],
      exec: "createAndEdit",
    },

    // Profile viewers
    profileViewers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 20 },
        { duration: "2m", target: 50 },
        { duration: "1m", target: 50 },
        { duration: "15s", target: 0 },
      ],
      exec: "viewProfiles",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000", "p(99)<5000"],
    errors: ["count<200"],
    browse_duration: ["p(95)<2000"],
    auth_action_duration: ["p(95)<3000"],
  },
};

// --- Scenario functions ---

export function browse() {
  group("anonymous_browse", () => {
    const start = Date.now();

    // List playgrounds
    const listRes = http.get(`${BASE_URL}/api/playgrounds`);
    const ok = check(listRes, { "list 200": (r) => r.status === 200 });
    if (!ok) {
      errors.add(1);
      return;
    }

    // Click into a random playground
    try {
      const playgrounds = listRes.json();
      if (Array.isArray(playgrounds) && playgrounds.length > 0) {
        const pg = playgrounds[Math.floor(Math.random() * playgrounds.length)];
        http.get(`${BASE_URL}/api/playgrounds/${pg.hash}`, {
          tags: { name: "GET /api/playgrounds/:hash" },
        });

        // Sometimes view commits too (50% chance)
        if (Math.random() > 0.5) {
          http.get(`${BASE_URL}/api/playgrounds/${pg.hash}/commits`, {
            tags: { name: "GET /api/playgrounds/:hash/commits" },
          });
        }
      }
    } catch {
      // empty DB
    }

    browseDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 3 + 1); // 1-4s think time
}

export function createAndEdit() {
  const vuId = __VU;

  group("auth_create_edit", () => {
    const start = Date.now();

    // Register
    const { sessionCookie } = registerUser(vuId);
    if (!sessionCookie) {
      errors.add(1);
      return;
    }
    const headers = authHeaders(sessionCookie);

    // Create playground
    const createRes = http.post(
      `${BASE_URL}/api/playgrounds`,
      JSON.stringify({
        name: `mixed-${vuId}-${Date.now()}`,
        message: "load test commit",
        files: sampleFiles(),
        activeFile: "query.sql",
      }),
      { headers },
    );

    if (createRes.status !== 200) {
      errors.add(1);
      return;
    }

    try {
      const { playground_hash: hash } = createRes.json();

      sleep(0.5);

      // Make 2-3 commits
      const numCommits = Math.floor(Math.random() * 2) + 2;
      for (let i = 0; i < numCommits; i++) {
        http.post(
          `${BASE_URL}/api/playgrounds/${hash}/commits`,
          JSON.stringify({
            message: `commit ${i + 2}`,
            files: [
              {
                path: "query.sql",
                content: `-- Commit ${i + 2} at ${Date.now()}\nSELECT ${i};`,
              },
            ],
            activeFile: "query.sql",
          }),
          { headers, tags: { name: "POST /api/playgrounds/:hash/commits" } },
        );
        sleep(0.3);
      }
    } catch {
      errors.add(1);
    }

    authDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 2 + 1);
}

export function viewProfiles() {
  group("view_profiles", () => {
    const start = Date.now();

    // First get some playgrounds to find usernames
    const listRes = http.get(`${BASE_URL}/api/playgrounds`);
    try {
      const playgrounds = listRes.json();
      if (Array.isArray(playgrounds) && playgrounds.length > 0) {
        // Pick a random playground's user
        const pg = playgrounds[Math.floor(Math.random() * playgrounds.length)];
        if (pg.user && pg.user.username) {
          const profileRes = http.get(`${BASE_URL}/api/user/${pg.user.username}`, {
            tags: { name: "GET /api/user/:username" },
          });
          check(profileRes, {
            "profile 200": (r) => r.status === 200,
          });

          // Also try the /playgrounds sub-route
          http.get(`${BASE_URL}/api/user/${pg.user.username}/playgrounds`, {
            tags: { name: "GET /api/user/:username/playgrounds" },
          });
        }
      }
    } catch {
      // empty DB
    }

    profileDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 3 + 1);
}
