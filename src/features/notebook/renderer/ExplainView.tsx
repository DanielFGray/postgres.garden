import * as Effect from "effect/Effect";
import { AtomRegistry } from "fibrae";
import { createApp, type App } from "vue";
import Plan from "./pev2/components/Plan.vue";
import type { SQLResult } from "./types";

// Import pev2 styles
import "bootstrap/dist/css/bootstrap.min.css";
import "./pev2/assets/css/tippy-bootstrap.css";

interface ExplainViewProps {
  data: SQLResult;
}

let vueApp: App | null = null;
let initialized = false;

// Unique ID to find the container in the DOM after render
const CONTAINER_ID = "pev2-container-" + Math.random().toString(36).slice(2);

export function ExplainView({ data }: ExplainViewProps) {
  return Effect.gen(function* () {
    yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;

      // Schedule Vue mount after fibrae commits the DOM
      queueMicrotask(() => {
        const container = document.getElementById(CONTAINER_ID);
        if (!container) return;

        // Extract the plan from the result rows
        let planSource = "";

        if (data.rows.length > 0) {
          const firstRow = data.rows[0]!;
          const planField =
            firstRow["QUERY PLAN"] ?? firstRow["query plan"] ?? firstRow["Plan"];

          if (planField !== undefined) {
            if (typeof planField === "object" || Array.isArray(planField)) {
              planSource = JSON.stringify(planField, null, 2);
            } else if (
              typeof planField === "string" &&
              (planField.trim().startsWith("[") || planField.trim().startsWith("{"))
            ) {
              planSource = planField;
            } else {
              planSource = data.rows
                .map(
                  (row) =>
                    row["QUERY PLAN"] ?? row["query plan"] ?? Object.values(row)[0]
                )
                .join("\n");
            }
          } else {
            const firstValue = Object.values(firstRow)[0];
            if (typeof firstValue === "string") {
              planSource = data.rows
                .map((row) => Object.values(row)[0])
                .join("\n");
            } else if (typeof firstValue === "object") {
              planSource = JSON.stringify(firstValue, null, 2);
            }
          }
        }

        // Clean up previous Vue app if any
        if (vueApp) {
          vueApp.unmount();
          vueApp = null;
        }

        // Create Vue app with vendored pev2 Plan component
        const app = createApp(Plan, {
          planSource: planSource,
          planQuery: data.query || "",
        });

        vueApp = app;
        app.mount(container);
      });
    }

    return (
      <div class="explain-view">
        <div id={CONTAINER_ID} class="pev2-container" />
      </div>
    );
  });
}
