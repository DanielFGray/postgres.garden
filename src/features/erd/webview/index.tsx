import { Signal, signal } from "@preact/signals";
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

// Signals
const mermaidCode: Signal<string> = signal("");
const error: Signal<string> = signal("");
const loading: Signal<boolean> = signal(true);
const vscode = (window as any).acquireVsCodeApi?.();

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

// Notify extension that webview is ready
vscode?.postMessage({ type: "initialized" } as WebviewMessage);

// Handle messages from extension
const handleMessage = (event: MessageEvent<ERDMessage>) => {
  const message = event.data;

  switch (message.type) {
    case "load":
      if (message.data?.mermaidCode) {
        mermaidCode.value = message.data.mermaidCode;
        error.value = "";
        loading.value = false;
        renderDiagram(message.data.mermaidCode);
      }
      break;
    case "error":
      error.value = message.data?.message || "Unknown error";
      loading.value = false;
      break;
  }
};

window.addEventListener("message", handleMessage);

let panZoomInstance: ReturnType<typeof svgPanZoom> | null = null;

const renderDiagram = async (code: string) => {
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
    error.value = `Failed to render diagram: ${message}`;
    console.error("Mermaid render error:", err);
  }
};

const handleRefresh = () => {
  loading.value = true;
  vscode?.postMessage({ type: "refresh" } as WebviewMessage);
};

export function ERDViewer() {
  return (
    <div className="erd-viewer">

      {loading.value && <div className="loading">Loading schema...</div>}
      {error.value && <div className="error">{error.value}</div>}

      <div
        id="mermaid-container"
        className="mermaid-container"
        style={{ display: loading.value || error.value ? "none" : "block" }}
      />
    </div>
  );
}
