import { describe, expect, it } from "vitest";
import * as S from "effect/Schema";
import { PageStateSchema, type PageState } from "../src/shared/dehydrate.js";
import { injectInitialData } from "./initialData.js";

const decodeState = S.decodeUnknownSync(S.fromJsonString(PageStateSchema));

/** The state the page's script sets, read back the way JSON would be. */
const readBack = (html: string) => {
  const match = /<script>window\.__INITIAL_DATA__=([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return decodeState(match?.[1]);
};

const stateHolding = (text: string): PageState => ({
  user: null,
  commit: null,
  route: { type: "shared", data: text },
});

describe("injectInitialData", () => {
  it("keeps replacement patterns in the state as they are", () => {
    // Dollar quoting is how SQL writes a function body.
    const state = stateHolding("create function f() returns int as $$ select 1 $$; $& $` $' $1");

    const html = injectInitialData("<html><body><!-- {INITIAL_DATA} --></body></html>", state);

    expect(readBack(html)).toEqual(state);
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("puts the script before </body> when the page has no marker", () => {
    const state = stateHolding("$$");

    const html = injectInitialData("<html><body><main></main></body></html>", state);

    expect(readBack(html)).toEqual(state);
    expect(html).toMatch(/<\/script><\/body><\/html>$/);
  });

  it("keeps text that would close the script inside the string", () => {
    const state = stateHolding("</script><script>alert(1)</script> <!-- -->");

    const html = injectInitialData("<html><body><!-- {INITIAL_DATA} --></body></html>", state);

    expect(readBack(html)).toEqual(state);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});
