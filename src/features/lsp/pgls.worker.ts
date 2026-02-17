import { createLanguageServer, type LanguageServer } from "@postgres-language-server/wasm/lsp";
import { createWorkspace, type Workspace } from "@postgres-language-server/wasm/workspace";

let lsp: LanguageServer | null = null;
let workspace: Workspace | null = null;
const pendingMessages: MessageEvent[] = [];

/**
 * Track open documents so we can use Workspace API for completions/hover.
 * The LSP handler has its own internal document tracking, but we can't access it.
 * We mirror document state here for the Workspace API.
 */
const documents = new Map<string, string>();

function processMessage(event: MessageEvent) {
  if (!lsp) return;

  const msg = event.data as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };

  // Intercept schema sync — use Workspace API (synchronous) which works,
  // unlike the LSP notification path that loses the actual serde error.
  if (msg.method === "pgls/setSchema" && workspace) {
    try {
      const schema = msg.params?.schema as string | undefined;
      if (schema) {
        workspace.setSchema(schema);
        console.log("[PGLS Worker] Schema set via Workspace API");
      }
    } catch (err) {
      console.error(
        "[PGLS Worker] setSchema error:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return;
  }

  // Mirror document state to Workspace for completions/hover
  if (msg.method === "textDocument/didOpen" && workspace) {
    const p = msg.params as { textDocument?: { uri?: string; text?: string } };
    if (p.textDocument?.uri && p.textDocument.text != null) {
      documents.set(p.textDocument.uri, p.textDocument.text);
      workspace.insertFile(p.textDocument.uri, p.textDocument.text);
    }
  }
  if (msg.method === "textDocument/didChange" && workspace) {
    const p = msg.params as {
      textDocument?: { uri?: string };
      contentChanges?: { text: string }[];
    };
    const uri = p.textDocument?.uri;
    const text = p.contentChanges?.[p.contentChanges.length - 1]?.text;
    if (uri && text != null) {
      documents.set(uri, text);
      workspace.insertFile(uri, text);
    }
  }
  if (msg.method === "textDocument/didClose" && workspace) {
    const p = msg.params as { textDocument?: { uri?: string } };
    if (p.textDocument?.uri) {
      documents.delete(p.textDocument.uri);
      workspace.removeFile(p.textDocument.uri);
    }
  }

  // Intercept completion requests — use Workspace API for schema-aware results
  if (msg.method === "textDocument/completion" && workspace && msg.id != null) {
    try {
      const p = msg.params as {
        textDocument?: { uri?: string };
        position?: { line: number; character: number };
      };
      const uri = p.textDocument?.uri;
      const pos = p.position;
      const content = uri ? documents.get(uri) : undefined;

      if (uri && pos && content != null) {
        const offset = positionToOffset(content, pos.line, pos.character);
        const completions = workspace.complete(uri, offset);
        self.postMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: completions.map((c: { label: string; kind: string; detail?: string }) => ({
            label: c.label,
            kind: completionKindToLsp(c.kind),
            detail: c.detail,
          })),
        });
        return;
      }
    } catch {
      // Fall through to LSP handler on error
    }
  }

  // Intercept hover requests — use Workspace API for schema-aware results
  if (msg.method === "textDocument/hover" && workspace && msg.id != null) {
    try {
      const p = msg.params as {
        textDocument?: { uri?: string };
        position?: { line: number; character: number };
      };
      const uri = p.textDocument?.uri;
      const pos = p.position;
      const content = uri ? documents.get(uri) : undefined;

      if (uri && pos && content != null) {
        const offset = positionToOffset(content, pos.line, pos.character);
        const hover = workspace.hover(uri, offset);
        self.postMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: hover
            ? { contents: { kind: "markdown", value: hover } }
            : null,
        });
        return;
      }
    } catch {
      // Fall through to LSP handler on error
    }
  }

  // Everything else (initialize, didOpen/Change/Close for diagnostics, etc.) → LSP
  try {
    const responses = lsp.handleMessage(event.data as string);
    for (const resp of responses) {
      self.postMessage(resp);
    }
  } catch (err) {
    console.error(
      "[PGLS Worker] handleMessage error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Convert LSP line:character to byte offset. */
function positionToOffset(content: string, line: number, character: number): number {
  let offset = 0;
  const lines = content.split("\n");
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  // Approximate: character is UTF-16 offset, but for ASCII this is fine
  offset += Math.min(character, (lines[line] ?? "").length);
  return offset;
}

/** Map PGLS completion kind string to LSP CompletionItemKind number. */
function completionKindToLsp(kind: string): number {
  switch (kind) {
    case "table": return 7;     // Class
    case "column": return 5;    // Field
    case "function": return 3;  // Function
    case "schema": return 9;    // Module
    case "keyword": return 14;  // Keyword
    default: return 1;          // Text
  }
}

// Set up message handler IMMEDIATELY so no messages are lost
self.onmessage = (event: MessageEvent) => {
  if (!lsp) {
    pendingMessages.push(event);
    return;
  }
  processMessage(event);
};

// Initialize WASM
try {
  lsp = await createLanguageServer();
  // createWorkspace reuses the singleton WASM module from loadWasm()
  workspace = await createWorkspace();
  console.log("[PGLS] WASM language server ready");

  // Process any messages that arrived during init
  for (const msg of pendingMessages) {
    processMessage(msg);
  }
  pendingMessages.length = 0;
} catch (err) {
  console.error(
    "[PGLS Worker] Failed to initialize:",
    err instanceof Error ? err.message : String(err),
  );
}
