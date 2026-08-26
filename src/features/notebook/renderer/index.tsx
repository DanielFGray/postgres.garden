import { render } from "@solidjs/web";
import type { ActivationFunction } from "vscode-notebook-renderer";
import errorOverlay from "vscode-notebook-error-overlay";
import { SQLResultRenderer } from "./SQLResultRenderer";
import type { SQLResult } from "./types";
import cssText from "virtual:renderer-css";
import "./styles.css";

// Solid's `render` appends and hands back a disposer rather than replacing the
// subtree, so each output's root must be torn down before it is re-rendered and
// when VS Code discards it — otherwise its reactive graph and the document-level
// listeners its children attach outlive the output.
const disposers = new Map<string, () => void>();

const disposeOutput = (id: string) => {
  disposers.get(id)?.();
  disposers.delete(id);
};

export const activate: ActivationFunction = () => ({
  renderOutputItem(outputItem, element) {
    let shadow = element.shadowRoot;
    if (!shadow) {
      shadow = element.attachShadow({ mode: "open" });

      // Inject all renderer CSS into the shadow root so styles are
      // self-contained and isolated from the outer VS Code UI.
      const style = document.createElement("style");
      style.textContent = cssText;
      shadow.append(style);

      const root = document.createElement("div");
      root.id = "root";
      shadow.append(root);
    }

    const root = shadow.querySelector<HTMLElement>("#root")!;
    errorOverlay.wrap(root, () => {
      disposeOutput(outputItem.id);
      const data = outputItem.json() as SQLResult;
      disposers.set(
        outputItem.id,
        render(() => <SQLResultRenderer data={data} mime={outputItem.mime} />, root),
      );
    });
  },

  disposeOutputItem(id) {
    if (id === undefined) {
      for (const dispose of disposers.values()) dispose();
      disposers.clear();
    } else {
      disposeOutput(id);
    }
  },
});
