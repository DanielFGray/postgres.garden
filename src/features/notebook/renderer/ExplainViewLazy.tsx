import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import type { VElement } from "fibrae";
import type { SQLResult } from "./types";

interface Props {
  data: SQLResult;
}

type ExplainViewComponent = (props: Props) => Effect.Effect<VElement, never, AtomRegistry.AtomRegistry>;

const componentAtom = Atom.make<ExplainViewComponent | null>(null);
const loadingAtom = Atom.make(true);
const errorAtom = Atom.make<string | null>(null);

let initialized = false;

export function ExplainViewLazy({ data }: Props) {
  return Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;

      import("./ExplainView")
        .then((mod) => {
          registry.set(componentAtom, mod.ExplainView as ExplainViewComponent);
          registry.set(loadingAtom, false);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
          registry.set(loadingAtom, false);
        });
    }

    const loading = yield* Atom.get(loadingAtom);
    const error = yield* Atom.get(errorAtom);
    const Component = yield* Atom.get(componentAtom);

    if (loading) return <div class="explain-loading">Loading visualizer...</div>;
    if (error) return <div class="explain-error">Failed to load: {error}</div>;
    if (!Component) return <></>;

    return <Component data={data} />;
  });
}
