import {
  registerExtension,
  ExtensionHostKind,
} from "@codingame/monaco-vscode-api/extensions";
import * as vscode from "vscode";
import { api } from "../api-client";
import { parseRoute } from "../routes";
import { GITHUB_SIGNIN, PLAYGROUND_REPORT_OPEN } from "./constants";

type ReportReason =
  | "illegal_content"
  | "pii_exposure"
  | "spam"
  | "harassment"
  | "copyright"
  | "other";

interface ReportReasonItem extends vscode.QuickPickItem {
  value: ReportReason;
}

const reportReasons: ReportReasonItem[] = [
  {
    label: "Illegal content",
    value: "illegal_content",
    description: "Content that violates laws or regulations",
  },
  {
    label: "PII exposure",
    value: "pii_exposure",
    description: "Personal or sensitive data exposed",
  },
  {
    label: "Spam",
    value: "spam",
    description: "Irrelevant or repetitive content",
  },
  {
    label: "Harassment",
    value: "harassment",
    description: "Threatening, abusive, or hateful content",
  },
  {
    label: "Copyright",
    value: "copyright",
    description: "Copyrighted material shared without permission",
  },
  {
    label: "Other",
    value: "other",
    description: "Something else that needs review",
  },
];

const reportedPlaygrounds = new Set<string>();
let activePlaygroundHash: string | null = null;
let signedInUserId: string | null = null;
let refreshToken = 0;
let statusBarItem: vscode.StatusBarItem | null = null;

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) {
    const message = (value as { error?: unknown }).error;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function getRoutePlaygroundHash(): string | null {
  const route = parseRoute(window.location.href);
  if (!route || (route.type !== "playground" && route.type !== "commit")) {
    return null;
  }
  return route.params.playgroundId ?? null;
}

function hideStatusBar() {
  activePlaygroundHash = null;
  statusBarItem?.hide();
}

function updateStatusBar() {
  if (!statusBarItem || !activePlaygroundHash) return;

  if (reportedPlaygrounds.has(activePlaygroundHash)) {
    statusBarItem.text = "$(check) Reported";
    statusBarItem.tooltip = "You already reported this playground";
    statusBarItem.command = undefined;
    statusBarItem.show();
    return;
  }

  statusBarItem.text = "$(report) Report";
  statusBarItem.tooltip = signedInUserId
    ? "Report this playground"
    : "Sign in to report this playground";
  statusBarItem.command = PLAYGROUND_REPORT_OPEN;
  statusBarItem.show();
}

async function refreshReportButton() {
  if (!statusBarItem) return;

  const playgroundHash = getRoutePlaygroundHash();
  if (!playgroundHash) {
    hideStatusBar();
    return;
  }

  const token = ++refreshToken;

  const { data: playground, error: playgroundError } = await api(
    "/api/playgrounds/:hash",
    {
      method: "GET",
      params: { hash: playgroundHash },
    },
  );

  if (token !== refreshToken) return;

  if (playgroundError || !playground || "error" in playground) {
    hideStatusBar();
    return;
  }

  if (playground.privacy === "private") {
    hideStatusBar();
    return;
  }

  const meResponse = await api("/api/me", { credentials: "include" });
  if (token !== refreshToken) return;

  const me =
    meResponse.data && !("error" in meResponse.data)
      ? meResponse.data
      : null;
  signedInUserId = me?.user?.id ?? null;

  if (signedInUserId && playground.user_id === signedInUserId) {
    hideStatusBar();
    return;
  }

  activePlaygroundHash = playgroundHash;
  updateStatusBar();
}

async function promptSignIn() {
  const action = await vscode.window.showInformationMessage(
    "Sign in to report playgrounds.",
    "Sign In",
  );
  if (action === "Sign In") {
    await vscode.commands.executeCommand(GITHUB_SIGNIN);
  }
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const { getApi } = registerExtension(
  {
    name: "playground-report",
    publisher: "postgres.garden",
    description: "Report shared playgrounds",
    version: "1.0.0",
    engines: { vscode: "*" },
    contributes: {
      commands: [
        {
          command: PLAYGROUND_REPORT_OPEN,
          title: "Report Playground",
          icon: "$(report)",
        },
      ],
    },
  },
  ExtensionHostKind.LocalProcess,
);

void getApi().then((vsapi) => {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    70,
  );

  vsapi.commands.registerCommand(PLAYGROUND_REPORT_OPEN, async () => {
    const playgroundHash = activePlaygroundHash ?? getRoutePlaygroundHash();
    if (!playgroundHash) {
      void vscode.window.showErrorMessage("No playground to report");
      return;
    }

    const meResponse = await api("/api/me", { credentials: "include" });
    const me =
      meResponse.data && !("error" in meResponse.data)
        ? meResponse.data
        : null;
    signedInUserId = me?.user?.id ?? null;

    if (!signedInUserId) {
      await promptSignIn();
      return;
    }

    if (reportedPlaygrounds.has(playgroundHash)) {
      void vscode.window.showInformationMessage(
        "You already reported this playground.",
      );
      updateStatusBar();
      return;
    }

    const reason = await vscode.window.showQuickPick(reportReasons, {
      title: "Report playground",
      placeHolder: "Select a reason",
      matchOnDescription: true,
    });

    if (!reason) return;

    const details = await vscode.window.showInputBox({
      title: "Additional details (optional)",
      prompt: "Provide any context for the report (max 1000 characters)",
      validateInput: (value) =>
        value.length > 1000
          ? "Details must be 1000 characters or less"
          : null,
    });

    if (details === undefined) return;

    const confirmation = await vscode.window.showWarningMessage(
      `Report this playground for "${reason.label}"?`,
      { modal: true },
      "Report",
    );

    if (confirmation !== "Report") return;

    const { error } = await api("/api/playgrounds/:hash/report", {
      method: "POST",
      params: { hash: playgroundHash },
      body: {
        reason: reason.value,
        details: details.trim().length > 0 ? details.trim() : undefined,
      },
    });

    if (error) {
      if (error.status === 401) {
        await promptSignIn();
        return;
      }
      if (error.status === 403) {
        void vscode.window.showErrorMessage(
          extractErrorMessage(error.value, "You cannot report this playground"),
        );
        return;
      }
      if (error.status === 409) {
        reportedPlaygrounds.add(playgroundHash);
        updateStatusBar();
        void vscode.window.showInformationMessage(
          "You already reported this playground.",
        );
        return;
      }
      if (error.status === 429) {
        void vscode.window.showErrorMessage(
          "Report limit reached. Try again later.",
        );
        return;
      }
      void vscode.window.showErrorMessage(
        `Failed to submit report: ${error.status} ${JSON.stringify(error.value)}`,
      );
      return;
    }

    reportedPlaygrounds.add(playgroundHash);
    updateStatusBar();
    void vscode.window.showInformationMessage(
      "Report submitted. Thanks for helping keep postgres.garden safe.",
    );
  });

  if (window.navigation) {
    window.navigation.addEventListener("navigatesuccess", () => {
      void refreshReportButton();
    });
  }

  void refreshReportButton();
});
