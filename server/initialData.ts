/**
 * Puts the page state into server-rendered HTML, where the client reads it
 * back as `window.__INITIAL_DATA__` (see `src/shared/dehydrate.ts`).
 */

import * as S from "effect/Schema";
import { PageStateSchema, type PageState } from "../src/shared/dehydrate.js";

const marker = "<!-- {INITIAL_DATA} -->";

/**
 * Adds a script that sets `window.__INITIAL_DATA__` to `html`: at the marker
 * comment, else before `</body>`, else at the end.
 *
 * The script goes in through a replacer function. A replacement string would
 * read `$$`, `$&` and `` $` `` in the state as patterns, and SQL files hold
 * `$$` in every function body.
 */
export const injectInitialData = (html: string, state: PageState): string => {
  const payload = `<script>window.__INITIAL_DATA__=${serializeInitialData(state)}</script>`;
  if (html.includes(marker)) return html.replace(marker, () => payload);
  if (html.includes("</body>")) return html.replace("</body>", () => `${payload}</body>`);
  return `${html}${payload}`;
};

/** The state as JSON that cannot end the script element it sits in. */
const serializeInitialData = (state: PageState): string =>
  S.encodeSync(S.fromJsonString(PageStateSchema))(state)
    .replace(/</g, "\\u003c")
    .replace(/-->/g, "--\\u003e");
