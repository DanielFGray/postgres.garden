import { onCleanup } from "solid-js";
import { createApp } from "vue";
import * as S from "effect/Schema";
import Plan from "./pev2/components/Plan.vue";
import type { SQLResult, SqlValue } from "./types";
import "bootstrap/dist/css/bootstrap.min.css";
import "./pev2/assets/css/tippy-bootstrap.css";

const extractPlan = (data: SQLResult): string => {
  const encodeJson = S.encodeSync(S.fromJsonString(S.Unknown));
  const formatValue = (value: SqlValue | undefined): string =>
    typeof value === "object" && value !== null ? encodeJson(value) : String(value ?? "");
  if (data.rows.length === 0) return "";
  const first = data.rows[0]!;
  const field = first["QUERY PLAN"] ?? first["query plan"] ?? first.Plan;
  if (typeof field === "object" && field !== null) return encodeJson(field);
  if (typeof field === "string" && /^[{[]/.test(field.trim())) return field;
  if (field !== undefined) {
    return data.rows
      .map((row) => formatValue(row["QUERY PLAN"] ?? row["query plan"] ?? Object.values(row)[0]))
      .join("\n");
  }
  const value = Object.values(first)[0];
  return typeof value === "object"
    ? encodeJson(value)
    : data.rows.map((row) => formatValue(Object.values(row)[0])).join("\n");
};

/** Hosts the vendored pev2 Vue app inside the Solid renderer tree. */
export function ExplainView(props: { data: SQLResult }) {
  const mount = (el: HTMLDivElement) => {
    const app = createApp(Plan, {
      planSource: extractPlan(props.data),
      planQuery: props.data.query || "",
    });
    app.mount(el);
    onCleanup(() => app.unmount());
  };

  return (
    <div class="explain-view">
      <div ref={mount} class="pev2-container" />
    </div>
  );
}
