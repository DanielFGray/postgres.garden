import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import mermaid from "mermaid";
import svgPanZoom from "svg-pan-zoom";
import "./styles.css";

interface ERDMessage {
  type: "load" | "error";
  data?: {
    mermaidCode?: string;
    message?: string;
  };
}

interface WebviewMessage {
  type: "initialized" | "refresh";
}

// Atoms
const mermaidCodeAtom = Atom.make<string>("");
const errorAtom = Atom.make<string>("");
const loadingAtom = Atom.make<boolean>(true);

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}
const vscode = (window as unknown as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi?.();

/** Lighten a dark color or darken a light color by `amount` (0-255) */
function nudgeColor(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  // If it's a dark color, lighten; if light, darken
  const dir = (r + g + b) / 3 < 128 ? amount : -amount;
  const clamp = (v: number) => Math.max(0, Math.min(255, v + dir));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

/** Read a CSS custom property from :root, resolved to an actual value */
function cssVar(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim() || fallback
  );
}

/** Re-initialize mermaid with the current VS Code theme colors */
function initMermaidTheme() {
  const bg = cssVar("--vscode-editor-background", "#1e1e1e");
  const fg = cssVar("--vscode-editor-foreground", "#cccccc");
  const border = cssVar("--vscode-editorWidget-border", "#454545");
  const altBg = nudgeColor(bg, 12);
  const lineColor = cssVar("--vscode-editorLineNumber-foreground", "#858585");
  const font = cssVar("--vscode-font-family", "monospace");

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    themeVariables: {
      background: bg,
      primaryColor: bg,
      primaryTextColor: fg,
      primaryBorderColor: border,
      lineColor,
      textColor: fg,
      mainBkg: bg,
      nodeBorder: border,
      fontFamily: font,
    },
    themeCSS: `
      .er.entityBox { fill: ${bg}; stroke: ${border}; }
      .row-rect-even path { fill: ${bg}; }
      .row-rect-odd path { fill: ${altBg}; }
      .er.relationshipLine { stroke: ${lineColor}; }
      .er.relationshipLabel { fill: ${fg}; }
      text { fill: ${fg}; font-family: ${font}; }
      marker { fill: ${lineColor}; }
    `,
  });
}

let panZoomInstance: ReturnType<typeof svgPanZoom> | null = null;

const renderDiagram = async (code: string, registry: AtomRegistry.Registry) => {
  try {
    const container = document.getElementById("mermaid-container");
    if (!container) return;

    initMermaidTheme();

    if (panZoomInstance) {
      panZoomInstance.destroy();
      panZoomInstance = null;
    }

    container.innerHTML = "";
    const { svg } = await mermaid.render("erd-diagram", code);
    container.innerHTML = svg;

    const svgEl = container.querySelector("svg");
    if (svgEl) {
      // svg-pan-zoom needs explicit dimensions
      svgEl.style.width = "100%";
      svgEl.style.height = "100%";
      svgEl.style.maxWidth = "none";

      panZoomInstance = svgPanZoom(svgEl, {
        zoomEnabled: true,
        controlIconsEnabled: true,
        fit: true,
        center: true,
        minZoom: 0.1,
        maxZoom: 10,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    registry.set(errorAtom, `Failed to render diagram: ${message}`);
    console.error("Mermaid render error:", err);
  }
};

let initialized = false;

export const ERDViewer = () => Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry;

  if (!initialized) {
    initialized = true;

    window.addEventListener("message", (event: MessageEvent<ERDMessage>) => {
      const message = event.data;

      switch (message.type) {
        case "load":
          if (message.data?.mermaidCode) {
            registry.set(mermaidCodeAtom, message.data.mermaidCode);
            registry.set(errorAtom, "");
            registry.set(loadingAtom, false);
            void renderDiagram(message.data.mermaidCode, registry);
          }
          break;
        case "error":
          registry.set(errorAtom, message.data?.message || "Unknown error");
          registry.set(loadingAtom, false);
          break;
      }
    });

    vscode?.postMessage({ type: "initialized" });
  }

  const err = yield* Atom.get(errorAtom);
  const isLoading = yield* Atom.get(loadingAtom);

  return (
    <div className="erd-viewer">
      {isLoading && <div className="loading">Loading schema...</div>}
      {err && <div className="error">{err}</div>}

      <div
        id="mermaid-container"
        className="mermaid-container"
        style={{ display: isLoading || err ? "none" : "block" }}
      />
    </div>
  );
});
