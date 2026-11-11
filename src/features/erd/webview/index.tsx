import mermaid from "mermaid";
import svgPanZoom from "svg-pan-zoom";
import { Cause, Effect } from "effect";
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

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}
const vscode = (window as Window & { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi?.();

/** Lighten a dark color or darken a light color by `amount` (0-255) */
function nudgeColor(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  const dir = (r + g + b) / 3 < 128 ? amount : -amount;
  const clamp = (v: number) => Math.max(0, Math.min(255, v + dir));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

/** Read a CSS custom property from :root, resolved to an actual value */
function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
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
    // Mermaid 12 defaults to the ELK layout and the "neo" look. The themeCSS
    // below styles the classes of the dagre layout and the classic look.
    layout: "dagre",
    look: "classic",
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

function renderDiagram(code: string): Effect.Effect<void> {
  const container = document.getElementById("mermaid-container");
  const loadingEl = document.getElementById("erd-loading");
  const errorEl = document.getElementById("erd-error");
  if (!container) return Effect.void;

  return Effect.gen(function* () {
    initMermaidTheme();

    if (panZoomInstance) {
      panZoomInstance.destroy();
      panZoomInstance = null;
    }

    container.innerHTML = "";
    const { svg } = yield* Effect.promise(() => mermaid.render("erd-diagram", code));
    container.innerHTML = svg;

    if (loadingEl) loadingEl.style.display = "none";
    if (errorEl) errorEl.style.display = "none";
    container.style.display = "block";

    const svgEl = container.querySelector("svg");
    if (svgEl) {
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
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Effect.logError("Mermaid render error:", cause);
        const message = Cause.pretty(cause);
        if (errorEl) {
          errorEl.textContent = `Failed to render diagram: ${message}`;
          errorEl.style.display = "flex";
        }
        if (loadingEl) loadingEl.style.display = "none";
        container.style.display = "none";
      }),
    ),
  );
}

export function init() {
  const root = document.getElementById("root");
  if (!root) return;

  root.innerHTML = `<div class="erd-viewer">
		<div id="erd-loading" class="loading">Loading schema...</div>
		<div id="erd-error" class="error" style="display:none"></div>
		<div id="mermaid-container" class="mermaid-container" style="display:none"></div>
	</div>`;

  window.addEventListener("message", (event: MessageEvent<ERDMessage>) => {
    const message = event.data;

    switch (message.type) {
      case "load":
        if (message.data?.mermaidCode) {
          Effect.runFork(renderDiagram(message.data.mermaidCode));
        }
        break;
      case "error": {
        const errorEl = document.getElementById("erd-error");
        const loadingEl = document.getElementById("erd-loading");
        if (errorEl) {
          errorEl.textContent = message.data?.message || "Unknown error";
          errorEl.style.display = "flex";
        }
        if (loadingEl) loadingEl.style.display = "none";
        break;
      }
    }
  });

  vscode?.postMessage({ type: "initialized" });
}
