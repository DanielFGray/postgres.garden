import { useRef, useEffect } from "preact/hooks";
import { createApp, type App } from "vue";
import Plan from "./pev2/components/Plan.vue";
import type { SQLResult } from "./types";

// Import pev2 styles
import "bootstrap/dist/css/bootstrap.min.css";
import "./pev2/assets/css/tippy-bootstrap.css";

interface ExplainViewProps {
  data: SQLResult;
}

export function ExplainView({ data }: ExplainViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vueAppRef = useRef<App | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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

    // Create Vue app with vendored pev2 Plan component
    const app = createApp(Plan, {
      planSource: planSource,
      planQuery: data.query || "",
    });

    vueAppRef.current = app;
    app.mount(containerRef.current);

    return () => {
      if (vueAppRef.current) {
        vueAppRef.current.unmount();
        vueAppRef.current = null;
      }
    };
  }, [data]);

  return (
    <div class="explain-view">
      <div ref={containerRef} class="pev2-container" />
    </div>
  );
}
