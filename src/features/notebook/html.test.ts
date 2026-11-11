import { describe, expect, it } from "@effect/vitest";
import { renderRowsAsTable } from "./html";

const text = { name: "<b>col</b>", dataTypeID: 25 };

describe("renderRowsAsTable", () => {
  it("shows markup in column names and values as text", () => {
    const html = renderRowsAsTable({
      fields: [text],
      rows: [{ "<b>col</b>": "<img src=x onerror=alert(1)>" }, { "<b>col</b>": null }],
    });
    expect(html).toBe(
      "<table><thead><tr><th>&lt;b&gt;col&lt;/b&gt;</th></tr></thead><tbody>" +
        "<tr><td>&lt;img src=x onerror=alert(1)&gt;</td></tr>" +
        "<tr><td><i>null</i></td></tr></tbody></table>",
    );
  });

  it("shows a statement with no columns as text", () => {
    expect(renderRowsAsTable({ fields: [], rows: [], statement: "select '<script>'" })).toBe(
      "<table><tbody><tr><td>select '&lt;script&gt;'</td></tr></tbody></table>",
    );
  });

  it("shows an error message as text", () => {
    expect(renderRowsAsTable({ error: new Error('column "<x>" does not exist') })).toBe(
      "Error: column &quot;&lt;x&gt;&quot; does not exist",
    );
  });
});
