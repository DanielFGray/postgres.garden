// Seed script: Populate the database with realistic data
//
// Creates 200 users, each with 2-5 playgrounds, 1-3 commits each,
// and a power-law distribution of stars so some playgrounds are "popular".
//
// Run:  k6 run k6/00-seed.js
// Clean: DELETE FROM app_public.users WHERE username LIKE 'seed_%';

import http from "k6/http";
import { BASE_URL, authHeaders } from "./helpers.js";

const NUM_USERS = 200;

// Varied SQL templates to make data realistic
const SQL_TEMPLATES = [
  {
    path: "query.sql",
    content: `CREATE TABLE employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  department text NOT NULL,
  salary numeric(10,2),
  hired_at date DEFAULT current_date
);

INSERT INTO employees (name, department, salary) VALUES
  ('Alice', 'Engineering', 120000),
  ('Bob', 'Marketing', 85000),
  ('Charlie', 'Engineering', 135000),
  ('Diana', 'Sales', 95000);

SELECT department, avg(salary)::numeric(10,2) as avg_salary, count(*)
FROM employees
GROUP BY department
ORDER BY avg_salary DESC;`,
  },
  {
    path: "schema.sql",
    content: `CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id integer NOT NULL,
  title text NOT NULL,
  body text,
  published boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES posts ON DELETE CASCADE,
  author_id integer NOT NULL,
  body text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_comments_post ON comments (post_id);
CREATE INDEX idx_posts_author ON posts (author_id);

-- Get posts with comment counts
SELECT p.title, p.published, count(c.id) as comment_count
FROM posts p
LEFT JOIN comments c ON c.post_id = p.id
GROUP BY p.id
ORDER BY comment_count DESC;`,
  },
  {
    path: "analytics.sql",
    content: `CREATE TABLE events (
  id bigserial PRIMARY KEY,
  user_id integer,
  event_type text NOT NULL,
  payload jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_events_type ON events (event_type);
CREATE INDEX idx_events_created ON events (created_at DESC);
CREATE INDEX idx_events_payload ON events USING gin (payload);

INSERT INTO events (user_id, event_type, payload)
SELECT
  (random() * 100)::int,
  (ARRAY['page_view', 'click', 'signup', 'purchase'])[1 + (random() * 3)::int],
  jsonb_build_object('page', '/page/' || (random() * 50)::int)
FROM generate_series(1, 10000);

-- Funnel analysis
WITH daily_events AS (
  SELECT
    date_trunc('hour', created_at) AS hour,
    event_type,
    count(*) AS cnt
  FROM events
  GROUP BY 1, 2
)
SELECT hour, event_type, cnt,
  sum(cnt) OVER (PARTITION BY event_type ORDER BY hour) AS running_total
FROM daily_events
ORDER BY hour DESC, cnt DESC
LIMIT 20;`,
  },
  {
    path: "explain-demo.sql",
    content: `CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL,
  total numeric(10,2) NOT NULL,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id integer REFERENCES orders,
  product_name text NOT NULL,
  quantity integer NOT NULL,
  price numeric(10,2) NOT NULL
);

INSERT INTO orders (customer_id, total, status)
SELECT
  (random() * 1000)::int,
  (random() * 500 + 10)::numeric(10,2),
  (ARRAY['pending', 'shipped', 'delivered', 'cancelled'])[1 + (random() * 3)::int]
FROM generate_series(1, 5000);

EXPLAIN ANALYZE
SELECT o.id, o.total, o.status, count(oi.id) as item_count
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'pending'
GROUP BY o.id
ORDER BY o.total DESC
LIMIT 50;`,
  },
  {
    path: "recursive.sql",
    content: `CREATE TABLE categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  parent_id integer REFERENCES categories
);

INSERT INTO categories (name, parent_id) VALUES
  ('Electronics', NULL),
  ('Computers', 1),
  ('Laptops', 2),
  ('Desktops', 2),
  ('Phones', 1),
  ('Clothing', NULL),
  ('Shirts', 6),
  ('Pants', 6);

WITH RECURSIVE cat_tree AS (
  SELECT id, name, parent_id, 0 AS depth, name::text AS path
  FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.name, c.parent_id, ct.depth + 1,
         ct.path || ' > ' || c.name
  FROM categories c
  JOIN cat_tree ct ON c.parent_id = ct.id
)
SELECT * FROM cat_tree ORDER BY path;`,
  },
];

const PLAYGROUND_NAMES = [
  "join-examples", "window-functions", "cte-demo", "index-tuning",
  "jsonb-queries", "full-text-search", "partition-demo", "trigger-examples",
  "plpgsql-basics", "lateral-joins", "array-ops", "date-math",
  "upsert-patterns", "materialized-views", "row-security", "foreign-data",
  "pg-stats", "vacuum-analyze", "toast-demo", "advisory-locks",
];

export const options = {
  // Seed runs serially — not a load test
  scenarios: {
    seed: {
      executor: "shared-iterations",
      vus: 10,
      iterations: NUM_USERS,
      maxDuration: "10m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
  },
};

export function setup() {
  // Collect all playground hashes so we can distribute stars in default()
  return { playgroundHashes: [] };
}

export default function () {
  const i = __ITER;

  // 1. Register user
  const username = `seed_${String(i).padStart(4, "0")}_${Math.random().toString(36).slice(2, 6)}`;
  const regRes = http.post(
    `${BASE_URL}/register`,
    JSON.stringify({
      username,
      email: `${username}@seed.local`,
      password: "SeedPass123!",
    }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (regRes.status !== 200) return;

  const sessionCookie = regRes.cookies["session"]
    ? regRes.cookies["session"][0].value
    : null;
  if (!sessionCookie) return;

  const headers = authHeaders(sessionCookie);

  // 2. Create 2-5 playgrounds
  const numPlaygrounds = Math.floor(Math.random() * 4) + 2;
  const myHashes = [];

  for (let p = 0; p < numPlaygrounds; p++) {
    const nameBase = PLAYGROUND_NAMES[(i * 5 + p) % PLAYGROUND_NAMES.length];
    const template = SQL_TEMPLATES[(i + p) % SQL_TEMPLATES.length];

    const createRes = http.post(
      `${BASE_URL}/api/playgrounds`,
      JSON.stringify({
        name: `${nameBase}-${username.slice(-4)}-${p}`,
        message: "initial commit",
        description: `Example: ${nameBase.replace(/-/g, " ")}`,
        files: [template],
        activeFile: template.path,
      }),
      { headers },
    );

    if (createRes.status !== 200) continue;

    let hash;
    try {
      hash = createRes.json().playground_hash;
    } catch {
      continue;
    }
    if (!hash) continue;
    myHashes.push(hash);

    // 3. Make 1-3 additional commits
    const numCommits = Math.floor(Math.random() * 3) + 1;
    for (let c = 0; c < numCommits; c++) {
      const nextTemplate = SQL_TEMPLATES[(i + p + c + 1) % SQL_TEMPLATES.length];
      http.post(
        `${BASE_URL}/api/playgrounds/${hash}/commits`,
        JSON.stringify({
          message: `update ${c + 1}: added ${nextTemplate.path}`,
          files: [
            template,
            { path: nextTemplate.path, content: nextTemplate.content },
          ],
          activeFile: nextTemplate.path,
        }),
        { headers, tags: { name: "POST /api/playgrounds/:hash/commits" } },
      );
    }
  }

  // 4. Star other playgrounds (power-law distribution)
  //    Fetch the public list and star some of them
  const listRes = http.get(`${BASE_URL}/api/playgrounds`);
  try {
    const playgrounds = listRes.json();
    if (!Array.isArray(playgrounds) || playgrounds.length === 0) return;

    // Star 5-15 random playgrounds, biased toward the top of the list
    // (which creates a rich-get-richer effect — power law)
    const numStars = Math.floor(Math.random() * 11) + 5;
    const starred = new Set();

    for (let s = 0; s < numStars; s++) {
      // Bias toward lower indices (more popular playgrounds)
      const biasedIdx = Math.floor(Math.pow(Math.random(), 1.5) * playgrounds.length);
      const target = playgrounds[biasedIdx];
      if (!target || starred.has(target.hash)) continue;
      starred.add(target.hash);

      // Don't star your own
      if (myHashes.includes(target.hash)) continue;

      http.post(`${BASE_URL}/api/playgrounds/${target.hash}/star`, null, {
        headers,
        tags: { name: "POST /api/playgrounds/:hash/star" },
      });
    }
  } catch {
    // ok
  }
}

export function teardown() {
  console.log("Seed complete. Check row counts:");
  console.log("  SELECT count(*) FROM app_public.users WHERE username LIKE 'seed_%';");
  console.log("  SELECT count(*) FROM app_public.playgrounds;");
  console.log("  SELECT count(*) FROM app_public.playground_stars;");
}
