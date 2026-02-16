/** @typedef {import("graphile-worker").Task} Task */

const MATCH_TEXT_LIMIT = 200;
const MAX_MATCHES_PER_RULE_FILE = 50;
const SEVERITY_RANK = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const HIGH_SEVERITY = new Set(["high", "critical"]);

const isCreditCardRule = (ruleName) =>
  typeof ruleName === "string" && ruleName.toLowerCase().includes("credit card");

const normalizeMatchText = (value) =>
  value.length > MATCH_TEXT_LIMIT ? value.slice(0, MATCH_TEXT_LIMIT) : value;

const luhnCheck = (value) => {
  let sum = 0;
  let shouldDouble = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = value.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
};

const buildLineStarts = (content) => {
  const starts = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
};

const findLineNumber = (lineStarts, index) => {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(high + 1, 1);
};

const buildRuleRegexes = (rules) =>
  rules
    .map((rule) => {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        return { ...rule, regex };
      } catch (error) {
        console.warn(
          `content_scan_rules: invalid regex for rule ${rule.id} (${rule.name}): ${error}`,
        );
        return null;
      }
    })
    .filter(Boolean);

const extractMatches = (rule, content, filePath, lineStarts) => {
  const matches = [];
  const regex = rule.regex;
  regex.lastIndex = 0;

  while (matches.length < MAX_MATCHES_PER_RULE_FILE) {
    const match = regex.exec(content);
    if (!match) break;
    if (match[0] === "") {
      regex.lastIndex += 1;
      continue;
    }

    const matchText = match[0];
    if (isCreditCardRule(rule.name)) {
      const digits = matchText.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) {
        continue;
      }
    }

    matches.push({
      matched_text: normalizeMatchText(matchText),
      file_path: filePath,
      line_number: findLineNumber(lineStarts, match.index),
    });
  }

  return matches;
};

/** @type {Task} */
export default async (payload, { withPgClient }) => {
  const commitId = payload?.commit_id;
  if (!commitId) {
    console.warn("scan_playground_content: missing commit_id payload");
    return;
  }

  await withPgClient(async (client) => {
    const rulesResult = await client.query(
      `select id, name, pattern, severity::text as severity, category::text as category
       from app_private.content_scan_rules
       where enabled is true`,
    );
    if (!rulesResult.rows.length) return;

    const commitResult = await client.query(
      `select playground_hash, data
       from app_public.playground_commits
       where id = $1`,
      [commitId],
    );
    const commit = commitResult.rows[0];
    if (!commit) return;

    let data = commit.data;
    if (typeof commit.data === "string") {
      try {
        data = JSON.parse(commit.data);
      } catch (error) {
        console.warn(`scan_playground_content: invalid commit data: ${error}`);
        return;
      }
    }
    const files = Array.isArray(data?.files) ? data.files : [];
    if (!files.length) return;

    const rules = buildRuleRegexes(rulesResult.rows);
    if (!rules.length) return;

    const matches = [];
    for (const file of files) {
      if (!file || typeof file.content !== "string") continue;
      const filePath = typeof file.path === "string" ? file.path : "";
      const lineStarts = buildLineStarts(file.content);

      for (const rule of rules) {
        const ruleMatches = extractMatches(
          rule,
          file.content,
          filePath,
          lineStarts,
        );
        if (!ruleMatches.length) continue;

        for (const match of ruleMatches) {
          matches.push({
            playground_hash: commit.playground_hash,
            commit_id: commitId,
            rule_id: rule.id,
            matched_text: match.matched_text,
            file_path: match.file_path,
            line_number: match.line_number,
            severity: rule.severity,
            category: rule.category,
            status: "pending",
          });
        }
      }
    }

    if (!matches.length) return;

    await client.query(
      `insert into app_public.content_flags
        (playground_hash, commit_id, rule_id, matched_text, file_path, line_number, severity, category, status)
       select * from jsonb_to_recordset($1::jsonb)
         as t(playground_hash text, commit_id text, rule_id bigint, matched_text text, file_path text, line_number integer, severity text, category text, status text)`,
      [JSON.stringify(matches)],
    );

    const shouldReport = matches.some((match) =>
      HIGH_SEVERITY.has(match.severity),
    );
    if (!shouldReport) return;

    await client.query(
      `insert into app_public.playground_reports
        (playground_hash, commit_id, reporter_id, reason, details)
       select $1, $2, null, 'content_scan', $3::jsonb
       where not exists (
         select 1 from app_public.playground_reports
         where playground_hash = $1
           and commit_id = $2
           and reporter_id is null
           and reason = 'content_scan'
       )`,
      [
        commit.playground_hash,
        commitId,
        JSON.stringify({
          flagged_count: matches.length,
          highest_severity: matches.reduce(
            (current, match) =>
              SEVERITY_RANK[match.severity] > SEVERITY_RANK[current]
                ? match.severity
                : current,
            "low",
          ),
        }),
      ],
    );
  });
};
