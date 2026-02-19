import * as vscode from "vscode";
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";

export type NetworkState = "online" | "offline";

let currentState: NetworkState = navigator.onLine ? "online" : "offline";

const emitter = new vscode.EventEmitter<NetworkState>();

export const onDidChangeNetworkState: vscode.Event<NetworkState> = emitter.event;

export function getNetworkState(): NetworkState {
  return currentState;
}

function setState(next: NetworkState) {
  if (next === currentState) return;
  currentState = next;
  emitter.fire(next);
}

// --- Extension registration ---

const ext = registerExtension(
  {
    name: "network-status",
    publisher: "postgres.garden",
    description: "Network status detection",
    version: "1.0.0",
    engines: { vscode: "*" },
  },
  ExtensionHostKind.LocalProcess,
);

void ext.getApi().then(() => {
  window.addEventListener("online", () => setState("online"));
  window.addEventListener("offline", () => setState("offline"));
});
