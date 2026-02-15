// Scenario: Anonymous users browsing public playgrounds
//
// This hammers the endpoints with the star count N+1 problem.
// Watch for: response times climbing, DB connection exhaustion.
//
// Run:  k6 run k6/01-browse.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL } from "./helpers.js";

const listDuration = new Trend("list_playgrounds_duration", true);
const detailDuration = new Trend("get_playground_duration", true);
const errors = new Counter("errors");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "15s", target: 20 },
        { duration: "30s", target: 100 },
        { duration: "1m", target: 200 },
        { duration: "1m", target: 200 }, // hold
        { duration: "15s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000"], // 95% of requests under 2s
    errors: ["count<100"],
  },
};

export default function () {
  // 1. List public playgrounds (default sort, server defaults to limit=50)
  const listRes = http.get(`${BASE_URL}/api/playgrounds`);
  listDuration.add(listRes.timings.duration);
  const listOk = check(listRes, {
    "list 200": (r) => r.status === 200,
    "list is array": (r) => {
      try {
        return Array.isArray(r.json());
      } catch {
        return false;
      }
    },
  });
  if (!listOk) errors.add(1);

  // 2. If we got playgrounds, fetch a random one's detail page
  try {
    const playgrounds = listRes.json();
    if (Array.isArray(playgrounds) && playgrounds.length > 0) {
      const random =
        playgrounds[Math.floor(Math.random() * playgrounds.length)];
      const detailRes = http.get(
        `${BASE_URL}/api/playgrounds/${random.hash}`,
        { tags: { name: "GET /api/playgrounds/:hash" } },
      );
      detailDuration.add(detailRes.timings.duration);
      const detailOk = check(detailRes, {
        "detail 200": (r) => r.status === 200,
      });
      if (!detailOk) errors.add(1);

      // 3. Fetch commits for that playground
      const commitsRes = http.get(
        `${BASE_URL}/api/playgrounds/${random.hash}/commits`,
        { tags: { name: "GET /api/playgrounds/:hash/commits" } },
      );
      check(commitsRes, {
        "commits 200": (r) => r.status === 200,
      });
    }
  } catch {
    // empty DB, that's fine
  }

  // 3. Also hit the sorted-by-stars variant
  const starsRes = http.get(
    `${BASE_URL}/api/playgrounds?sort=stars`,
  );
  check(starsRes, { "stars sort 200": (r) => r.status === 200 });

  sleep(Math.random() * 2 + 0.5); // 0.5-2.5s think time
}
