import * as vscode from "vscode";
import {
  registerExtension,
  ExtensionHostKind,
} from "@codingame/monaco-vscode-api/extensions";
import { NETWORK_STATUS_SHOW } from "./constants";

export type NetworkState = "online" | "offline" | "degraded";

const HEALTHZ_TIMEOUT_MS = 5000;
const POLL_ONLINE_MS = 30_000;
const POLL_OFFLINE_MS = 10_000;
const DEBOUNCE_MS = 2000;

let currentState: NetworkState = navigator.onLine ? "online" : "offline";
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const emitter = new vscode.EventEmitter<NetworkState>();

export const onDidChangeNetworkState: vscode.Event<NetworkState> =
  emitter.event;

export function getNetworkState(): NetworkState {
  return currentState;
}

async function checkHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
    const res = await fetch("/healthz", { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function setState(next: NetworkState) {
  if (next === currentState) return;

  // Debounce: only commit state change if it persists
  if (debounceTimer != null) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    if (next === currentState) return;

    const prev = currentState;
    currentState = next;
    emitter.fire(next);
    showTransitionToast(prev, next);
    scheduleNextPoll();
  }, DEBOUNCE_MS);
}

function showTransitionToast(prev: NetworkState, next: NetworkState) {
  if (next === "offline") {
    void vscode.window.showWarningMessage(
      "You're offline \u2014 changes are saved locally",
    );
  } else if (next === "degraded" && prev !== "offline") {
    void vscode.window.showWarningMessage(
      "Connection issues \u2014 some features may be unavailable",
    );
  } else if (next === "online" && (prev === "offline" || prev === "degraded")) {
    void vscode.window.showInformationMessage("Back online");
  }
}

function scheduleNextPoll() {
  if (pollTimer != null) clearTimeout(pollTimer);
  if (document.hidden) return;

  const interval = currentState === "online" ? POLL_ONLINE_MS : POLL_OFFLINE_MS;
  pollTimer = setTimeout(() => void poll(), interval);
}

async function poll() {
  if (document.hidden) return;

  if (!navigator.onLine) {
    setState("offline");
    scheduleNextPoll();
    return;
  }

  const reachable = await checkHealth();
  setState(reachable ? "online" : "degraded");
  scheduleNextPoll();
}

// --- Extension registration ---

// eslint-disable-next-line @typescript-eslint/unbound-method
const { getApi } = registerExtension(
  {
    name: "network-status",
    publisher: "postgres.garden",
    description: "Network status detection",
    version: "1.0.0",
    engines: { vscode: "*" },
  },
  ExtensionHostKind.LocalProcess,
);

void getApi().then((vsapi) => {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50,
  );
  statusBarItem.command = NETWORK_STATUS_SHOW;

  function updateStatusBar(state: NetworkState) {
    switch (state) {
      case "online":
        statusBarItem.hide();
        break;
      case "offline":
        statusBarItem.text = "$(cloud-offline) Offline";
        statusBarItem.tooltip =
          "No network connection. Your SQL work is saved locally and will sync when you reconnect.";
        statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        statusBarItem.show();
        break;
      case "degraded":
        statusBarItem.text = "$(warning) Connection Issues";
        statusBarItem.tooltip =
          "Network is available but the server is unreachable. Sync and sharing may not work.";
        statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground",
        );
        statusBarItem.show();
        break;
    }
  }

  onDidChangeNetworkState(updateStatusBar);
  updateStatusBar(currentState);

  vsapi.commands.registerCommand(NETWORK_STATUS_SHOW, () => {
    const info =
      currentState === "online"
        ? "Connected to postgres.garden"
        : currentState === "offline"
          ? "You're offline. SQL editing works locally. Sync, sharing, and auth require a connection."
          : "Network is available but the server isn't responding. Try refreshing the page.";
    void vscode.window.showInformationMessage(info);
  });

  // Browser online/offline events for instant detection
  window.addEventListener("online", () => void poll());
  window.addEventListener("offline", () => setState("offline"));

  // Pause/resume polling on visibility change
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer != null) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    } else {
      void poll();
    }
  });

  // Initial poll
  void poll();
});
