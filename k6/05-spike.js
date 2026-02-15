// Scenario: Spike test — what happens when a HN/Reddit post hits
//
// Sudden burst from 0 to 500 users, sustained, then drop.
// This is the "goes viral" scenario. Watch for:
// - DB connection pool exhaustion (errors spike)
// - Response times going from ms to seconds
// - 5xx errors from unhandled promise rejections
//
// Run:  k6 run k6/05-spike.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { BASE_URL, registerUser, authHeaders, sampleFiles } from "./helpers.js";

const errors = new Counter("errors");
const spikeDuration = new Trend("spike_req_duration", true);

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 500 },   // instant spike
        { duration: "2m", target: 500 },    // hold the chaos
        { duration: "30s", target: 50 },    // most leave
        { duration: "1m", target: 50 },     // lingering traffic
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<5000"], // relaxed — we expect degradation
    http_req_failed: ["rate<0.1"],     // less than 10% errors
  },
};

export default function () {
  const roll = Math.random();

  if (roll < 0.7) {
    // 70% — anonymous browsing (the viral traffic)
    const res = http.get(`${BASE_URL}/api/playgrounds`);
    spikeDuration.add(res.timings.duration);
    const ok = check(res, { "list 200": (r) => r.status === 200 });
    if (!ok) errors.add(1);

    // Half of them click into a playground
    if (Math.random() > 0.5) {
      try {
        const playgrounds = res.json();
        if (Array.isArray(playgrounds) && playgrounds.length > 0) {
          const pg =
            playgrounds[Math.floor(Math.random() * playgrounds.length)];
          const detailRes = http.get(
            `${BASE_URL}/api/playgrounds/${pg.hash}`,
            { tags: { name: "GET /api/playgrounds/:hash" } },
          );
          spikeDuration.add(detailRes.timings.duration);
        }
      } catch {
        // ok
      }
    }
  } else if (roll < 0.9) {
    // 20% — try to register (new users from viral traffic)
    const res = http.post(
      `${BASE_URL}/register`,
      JSON.stringify({
        username: `spike_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        email: `spike_${Date.now()}@loadtest.local`,
        password: "SpikeTest123!",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    spikeDuration.add(res.timings.duration);
    const ok = check(res, {
      "register ok": (r) => r.status === 200 || r.status === 409,
    });
    if (!ok) errors.add(1);
  } else {
    // 10% — authenticated user creating a playground
    const { sessionCookie } = registerUser(__VU);
    if (sessionCookie) {
      const headers = authHeaders(sessionCookie);
      const res = http.post(
        `${BASE_URL}/api/playgrounds`,
        JSON.stringify({
          name: `spike-${Date.now()}`,
          message: "spike test",
          files: sampleFiles(),
          activeFile: "query.sql",
        }),
        { headers },
      );
      spikeDuration.add(res.timings.duration);
      check(res, { "create ok": (r) => r.status === 200 });
    }
  }

  sleep(Math.random() * 1.5 + 0.2); // fast browsing during viral spike
}
