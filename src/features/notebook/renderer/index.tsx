import { render } from "preact";
import type { ActivationFunction } from "vscode-notebook-renderer";
import errorOverlay from "vscode-notebook-error-overlay";
import { SQLResultRenderer } from "./SQLResultRenderer";
import type { SQLResult } from "./types";
import cssText from "virtual:renderer-css";
import "./styles.css";

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
      const data = outputItem.json() as SQLResult;
      render(<SQLResultRenderer data={data} mime={outputItem.mime} />, root);
    });
  },

  disposeOutputItem() {
    // Cleanup handled by Preact
  },
});
