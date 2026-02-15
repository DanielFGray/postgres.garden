// Scenario: Session validation stress test
//
// Every API request validates the session against the DB.
// This test measures how that scales by having many concurrent
// authenticated users making rapid requests.
//
// Run:  k6 run k6/04-session-stress.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import { BASE_URL, registerUser, authHeaders } from "./helpers.js";

const errors = new Counter("errors");
const sessionCheckRate = new Rate("session_check_success");

export const options = {
  scenarios: {
    session_hammering: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 50 },
        { duration: "20s", target: 200 },
        { duration: "1m", target: 500 },
        { duration: "30s", target: 500 },
        { duration: "10s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    session_check_success: ["rate>0.99"],
  },
};

export function setup() {
  // Pre-register a pool of users so we don't spend all our time registering
  const users = [];
  for (let i = 0; i < 50; i++) {
    const { sessionCookie } = registerUser(i);
    if (sessionCookie) {
      users.push(sessionCookie);
    }
  }
  console.log(`Pre-registered ${users.length} users`);
  return { sessions: users };
}

export default function (data) {
  if (data.sessions.length === 0) return;

  // Pick a random pre-registered session
  const cookie = data.sessions[__VU % data.sessions.length];
  const headers = authHeaders(cookie);

  // Rapid-fire session-validated requests
  const res = http.get(`${BASE_URL}/api/me`, { headers });
  const ok = check(res, {
    "me 200": (r) => r.status === 200,
    "has user": (r) => {
      try {
        return r.json().user != null;
      } catch {
        return false;
      }
    },
  });

  sessionCheckRate.add(ok ? 1 : 0);
  if (!ok) errors.add(1);

  // Also hit a read endpoint to test session + query together
  http.get(`${BASE_URL}/api/playgrounds`, { headers });

  sleep(0.1); // minimal think time — stress test
}
