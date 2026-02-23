/**
 * Search DSL tokenizer and parser.
 *
 * Supports:
 *   is:starred        — boolean filters
 *   by:username        — key:value filters
 *   by:"some user"     — quoted values
 *   sort:created       — sort specifier
 *   free text terms    — everything else
 *
 * Unknown filter keys are silently ignored (forward-compatible).
 */

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface FilterToken {
  readonly _tag: "filter";
  readonly key: string;
  readonly value: string;
}

interface TextToken {
  readonly _tag: "text";
  readonly value: string;
}

type Token = FilterToken | TextToken;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // skip whitespace
    if (input[i] === " " || input[i] === "\t") {
      i++;
      continue;
    }

    // try to match key:value (key is alphanumeric)
    const keyStart = i;
    while (i < len && /[a-zA-Z0-9_]/.test(input[i]!)) i++;

    if (i < len && i > keyStart && input[i] === ":") {
      const key = input.slice(keyStart, i).toLowerCase();
      i++; // skip colon

      // parse value — quoted or unquoted
      let value: string;
      if (i < len && (input[i] === '"' || input[i] === "'")) {
        const quote = input[i]!;
        i++; // skip opening quote
        const valStart = i;
        while (i < len && input[i] !== quote) i++;
        value = input.slice(valStart, i);
        if (i < len) i++; // skip closing quote
      } else {
        const valStart = i;
        while (i < len && input[i] !== " " && input[i] !== "\t") i++;
        value = input.slice(valStart, i);
      }

      tokens.push({ _tag: "filter", key, value });
    } else {
      // not a filter — backtrack and collect as text
      i = keyStart;
      const textStart = i;
      while (i < len && input[i] !== " " && input[i] !== "\t") i++;
      const word = input.slice(textStart, i);
      if (word) tokens.push({ _tag: "text", value: word });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parsed types
// ---------------------------------------------------------------------------

const SORT_MAP: Record<string, "created_at" | "updated_at" | "stars"> = {
  created: "created_at",
  updated: "updated_at",
  stars: "stars",
};

export type SortField = "created_at" | "updated_at" | "stars";

export interface ParsedSearch {
  readonly username: string | null;
  readonly sort: SortField;
  readonly text: string;
  readonly starred: boolean;
}

export interface ParsedSearchHint {
  readonly username: string | null;
  readonly sortLabel: string | null;
  readonly starred: boolean;
  readonly hasFilters: boolean;
}

// ---------------------------------------------------------------------------
// Parser (full — for server query building)
// ---------------------------------------------------------------------------

const SORT_LABELS: Record<string, string> = {
  created: "created",
  updated: "updated",
  stars: "stars",
};

export function parseSearchDSL(raw: string): ParsedSearch {
  let username: string | null = null;
  let sort: SortField = "created_at";
  let starred = false;
  const textParts: string[] = [];

  for (const token of tokenize(raw)) {
    if (token._tag === "text") {
      textParts.push(token.value);
      continue;
    }
    switch (token.key) {
      case "by":
        username = token.value;
        break;
      case "sort":
        if (SORT_MAP[token.value.toLowerCase()]) {
          sort = SORT_MAP[token.value.toLowerCase()]!;
        }
        break;
      case "is":
        if (token.value.toLowerCase() === "starred") starred = true;
        break;
      // unknown keys silently ignored
    }
  }

  return { username, sort, text: textParts.join(" "), starred };
}

// ---------------------------------------------------------------------------
// Parser (hint — for client display)
// ---------------------------------------------------------------------------

export function parseSearchHint(raw: string): ParsedSearchHint {
  let username: string | null = null;
  let sortLabel: string | null = null;
  let starred = false;

  for (const token of tokenize(raw)) {
    if (token._tag === "text") continue;
    switch (token.key) {
      case "by":
        username = token.value;
        break;
      case "sort":
        sortLabel = SORT_LABELS[token.value.toLowerCase()] ?? null;
        break;
      case "is":
        if (token.value.toLowerCase() === "starred") starred = true;
        break;
    }
  }

  return {
    username,
    sortLabel,
    starred,
    hasFilters: username !== null || sortLabel !== null || starred,
  };
}
