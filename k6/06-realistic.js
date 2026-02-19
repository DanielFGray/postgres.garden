// Scenario: Realistic load test against a seeded database
//
// Run 00-seed.js first to populate data, then run this.
// 4 concurrent scenarios simulating real user behavior.
//
// Run:  k6 run k6/06-realistic.js

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, registerUser, authHeaders, sampleFiles, starPlayground } from "./helpers.js";

const errors = new Counter("errors");
const browseDuration = new Trend("browse_duration", true);
const searchDuration = new Trend("search_duration", true);
const createDuration = new Trend("create_duration", true);
const engageDuration = new Trend("engage_duration", true);

export const options = {
  scenarios: {
    // 60% — Anonymous browsing (the bulk of traffic)
    browsers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 30 },
        { duration: "30s", target: 120 },
        { duration: "2m", target: 300 },
        { duration: "2m", target: 300 },
        { duration: "15s", target: 0 },
      ],
      exec: "browse",
    },

    // 15% — Profile/search browsing
    searchers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 30 },
        { duration: "2m", target: 75 },
        { duration: "2m", target: 75 },
        { duration: "15s", target: 0 },
      ],
      exec: "searchProfiles",
    },

    // 15% — Authenticated users creating content
    creators: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 30 },
        { duration: "2m", target: 75 },
        { duration: "2m", target: 75 },
        { duration: "15s", target: 0 },
      ],
      exec: "createContent",
    },

    // 10% — Users starring and browsing (engagement)
    engagers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 5 },
        { duration: "30s", target: 20 },
        { duration: "2m", target: 50 },
        { duration: "2m", target: 50 },
        { duration: "15s", target: 0 },
      ],
      exec: "engage",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<3000", "p(99)<5000"],
    http_req_failed: ["rate<0.05"],
    errors: ["count<200"],
    browse_duration: ["p(95)<2000"],
  },
};

// Helper: fetch a random playground from the list
function getRandomPlaygrounds() {
  const res = http.get(`${BASE_URL}/api/playgrounds`);
  try {
    const list = res.json();
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    // ok
  }
  return [];
}

// --- Scenario: Browse ---
export function browse() {
  group("browse", () => {
    const start = Date.now();

    // List by date (default)
    const listRes = http.get(`${BASE_URL}/api/playgrounds`);
    check(listRes, { "list 200": (r) => r.status === 200 });

    // 50% also sort by stars (hits the N+1 harder with real star data)
    if (Math.random() > 0.5) {
      http.get(`${BASE_URL}/api/playgrounds?sort=stars`);
    }

    // Click into a random playground
    try {
      const playgrounds = listRes.json();
      if (Array.isArray(playgrounds) && playgrounds.length > 0) {
        const pg = playgrounds[Math.floor(Math.random() * playgrounds.length)];

        // View detail
        http.get(`${BASE_URL}/api/playgrounds/${pg.hash}`, {
          tags: { name: "GET /api/playgrounds/:hash" },
        });

        // 60% view commits
        if (Math.random() > 0.4) {
          const commitsRes = http.get(`${BASE_URL}/api/playgrounds/${pg.hash}/commits`, {
            tags: { name: "GET /api/playgrounds/:hash/commits" },
          });

          // 30% view a specific commit + diff
          if (Math.random() > 0.7) {
            try {
              const commits = commitsRes.json();
              if (Array.isArray(commits) && commits.length > 0) {
                const commit = commits[Math.floor(Math.random() * commits.length)];
                http.get(`${BASE_URL}/api/playgrounds/${pg.hash}/commits/${commit.id}`, {
                  tags: { name: "GET /api/playgrounds/:hash/commits/:id" },
                });
                http.get(`${BASE_URL}/api/playgrounds/${pg.hash}/commits/${commit.id}/diff`, {
                  tags: { name: "GET /api/playgrounds/:hash/commits/:id/diff" },
                });
              }
            } catch {
              // ok
            }
          }
        }
      }
    } catch {
      // ok
    }

    browseDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 3 + 1);
}

// --- Scenario: Search/Profile viewing ---
export function searchProfiles() {
  group("search_profiles", () => {
    const start = Date.now();

    const playgrounds = getRandomPlaygrounds();
    if (playgrounds.length === 0) {
      sleep(2);
      return;
    }

    // Pick a user and view their profile
    const pg = playgrounds[Math.floor(Math.random() * playgrounds.length)];
    if (pg.user && pg.user.username) {
      http.get(`${BASE_URL}/api/user/${pg.user.username}`, {
        tags: { name: "GET /api/user/:username" },
      });

      // 50% also view their playground list
      if (Math.random() > 0.5) {
        http.get(`${BASE_URL}/api/user/${pg.user.username}/playgrounds`, {
          tags: { name: "GET /api/user/:username/playgrounds" },
        });
      }
    }

    // Browse another page of playgrounds
    http.get(`${BASE_URL}/api/playgrounds?sort=stars`);

    searchDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 3 + 1);
}

// --- Scenario: Create content ---
export function createContent() {
  group("create_content", () => {
    const start = Date.now();

    const { sessionCookie } = registerUser(__VU);
    if (!sessionCookie) {
      errors.add(1);
      return;
    }
    const headers = authHeaders(sessionCookie);

    // Create a playground
    const createRes = http.post(
      `${BASE_URL}/api/playgrounds`,
      JSON.stringify({
        name: `realistic-${__VU}-${Date.now()}`,
        message: "initial commit",
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

      // Make 1-2 more commits
      const numCommits = Math.floor(Math.random() * 2) + 1;
      for (let i = 0; i < numCommits; i++) {
        http.post(
          `${BASE_URL}/api/playgrounds/${hash}/commits`,
          JSON.stringify({
            message: `update ${i + 1}`,
            files: [
              {
                path: "query.sql",
                content: `-- v${i + 2}\nSELECT now(), ${i};`,
              },
            ],
            activeFile: "query.sql",
          }),
          { headers, tags: { name: "POST /api/playgrounds/:hash/commits" } },
        );
        sleep(0.3);
      }

      // Update metadata
      http.put(
        `${BASE_URL}/api/playgrounds/${hash}`,
        JSON.stringify({ description: "Updated during load test" }),
        { headers, tags: { name: "PUT /api/playgrounds/:hash" } },
      );
    } catch {
      errors.add(1);
    }

    createDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 2 + 1);
}

// --- Scenario: Engage (star + browse) ---
export function engage() {
  group("engage", () => {
    const start = Date.now();

    const { sessionCookie } = registerUser(__VU);
    if (!sessionCookie) {
      errors.add(1);
      return;
    }
    const headers = authHeaders(sessionCookie);

    // Browse and star things
    const playgrounds = getRandomPlaygrounds();
    if (playgrounds.length === 0) {
      sleep(2);
      return;
    }

    // Star 3-8 random playgrounds
    const numStars = Math.floor(Math.random() * 6) + 3;
    const starred = new Set();

    for (let s = 0; s < numStars && s < playgrounds.length; s++) {
      const idx = Math.floor(Math.random() * playgrounds.length);
      const pg = playgrounds[idx];
      if (starred.has(pg.hash)) continue;
      starred.add(pg.hash);

      starPlayground(pg.hash, headers);
      sleep(0.2);

      // View the playground after starring
      if (Math.random() > 0.5) {
        http.get(`${BASE_URL}/api/playgrounds/${pg.hash}`, {
          headers,
          tags: { name: "GET /api/playgrounds/:hash" },
        });
      }
    }

    engageDuration.add(Date.now() - start);
  });

  sleep(Math.random() * 3 + 1);
}
