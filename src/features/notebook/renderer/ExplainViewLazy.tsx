import { useState, useEffect } from "preact/hooks";
import type { ComponentType } from "preact";
import type { SQLResult } from "./types";

interface Props {
  data: SQLResult;
}

export function ExplainViewLazy({ data }: Props) {
  const [Component, setComponent] = useState<ComponentType<Props> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    import("./ExplainView")
      .then((mod) => {
        if (mounted) {
          setComponent(() => mod.ExplainView);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (loading) return <div class="explain-loading">Loading visualizer...</div>;
  if (error) return <div class="explain-error">Failed to load: {error}</div>;
  if (!Component) return null;

  return <Component data={data} />;
}
