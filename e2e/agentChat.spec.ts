/**
 * The agent chat's model/tool/result cycle, driven through the real
 * workbench. The Anthropic Messages endpoint is intercepted: each test
 * scripts the model's replies and decodes the requests the app sent, so no
 * paid model call is made.
 *
 * Startup seeds a shared-link workspace and waits for the existing
 * "Loaded shared workspace" notification after the editor opens. Provider
 * configuration runs once after that readiness — no whole-flow retry.
 */

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import * as S from "effect/Schema";
import { waitForNotification, waitForWorkbench } from "./helpers";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages**";

test.describe("agent chat", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
  });

  test("Agent runs SQL, edits a file, answers, and the edit undoes", async ({ page, context }) => {
    const model = await scriptModel(context, [
      turn(
        toolUse("runSql", {
          sql: "create table agent_probe (n int); insert into agent_probe values (41), (42); select n from agent_probe order by n",
        }),
      ),
      turn(toolUse("applyEdit", { path: "agent-note.txt", content: "by the agent\n" })),
      turn(textReply("Done: table and note are ready.")),
    ]);
    await openSharedApp(page);
    await configureProvider(page, anthropicMock);
    await send(page, "Make a table and a note.");
    await acceptGlobalAutoApproveIfAsked(page);

    await expect.poll(() => model.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(chatList(page)).toContainText("Done: table and note are ready.", {
      timeout: 60_000,
    });
    expect(model.requests).toHaveLength(3);
    expect(toolNames(model.requests[0])).toEqual(["applyEdit", "listFiles", "readFile", "runSql"]);
    expect(lastToolResult(model.requests[1])).toMatch(/"n":\s*41/);
    expect(lastToolResult(model.requests[1])).toMatch(/"n":\s*42/);
    expect(lastToolResult(model.requests[2])).toContain("Created agent-note.txt");

    // Plain text opens in a text editor whose undo stack the edit went through.
    await openWorkspaceFile(page, "agent-note.txt");
    const editor = page.locator(".editor-instance .monaco-editor").first();
    await expect(editor).toContainText("by the agent");
    await editor.click();
    await page.keyboard.press("Control+Z");
    await expect(editor).not.toContainText("by the agent");
  });

  test("the Effect provider refuses a tool name it was not offered", async ({ page, context }) => {
    const model = await scriptModel(context, [
      turn(toolUse("copilot_runInTerminal", { command: "echo pwned" })),
      turn(textReply("unreachable")),
    ]);
    await openSharedApp(page);
    await configureProvider(page, anthropicMock);
    await send(page, "Run a shell command.");

    // Installed Effect provider rejects undeclared tool calls before
    // participant authorizeTool runs.
    await expect(chatList(page)).toContainText("Tool 'copilot_runInTerminal' not found", {
      timeout: 30_000,
    });
    expect(model.requests).toHaveLength(1);
    expect(toolNames(model.requests[0])).toEqual(["applyEdit", "listFiles", "readFile", "runSql"]);
  });

  // Open defect: after Stop the chat shows no notice. The loop interrupts via the
  // abort signal and `onInterrupt` writes the notice, but it never renders.
  // Not yet isolated: interrupt path not reached, or the chat drops writes made
  // after cancellation.
  test.fixme("stopping a run while a model request is in flight says so and sends no further request", async ({
    page,
    context,
  }) => {
    // The first reply is held open; the test never releases it.
    const model = await scriptModel(context, [
      turn(toolUse("runSql", { sql: "select 1" }), () => new Promise<void>(() => {})),
      turn(textReply("unreachable")),
    ]);
    await openSharedApp(page);
    await configureProvider(page, anthropicMock);
    await send(page, "Say something.");
    await acceptGlobalAutoApproveIfAsked(page);

    // The request is recorded before its reply is awaited, so this is the
    // point at which the run is blocked on the model.
    await expect.poll(() => model.requests.length, { timeout: 30_000 }).toBe(1);
    await page.locator(".interactive-input-part .codicon-stop-circle").first().click();
    await expect(chatList(page)).toContainText("Stopped. No further tool calls run.", {
      timeout: 15_000,
    });
    expect(model.requests).toHaveLength(1);
  });
});

// --- Scripted model ---

/** The parts of an Anthropic Messages request body these tests read. */
const MessagesRequest = S.Struct({
  tools: S.optionalKey(S.Array(S.Struct({ name: S.String }))),
  messages: S.Array(
    S.Struct({
      role: S.String,
      content: S.Union([
        S.String,
        S.Array(S.Struct({ type: S.String, content: S.optionalKey(S.Unknown) })),
      ]),
    }),
  ),
});
type MessagesRequest = typeof MessagesRequest.Type;
const decodeMessagesRequest = S.decodeUnknownSync(S.fromJsonString(MessagesRequest));

interface Turn {
  readonly events: ReadonlyArray<object>;
  /** Resolves when the reply may be sent. */
  readonly ready: () => Promise<void>;
}

const turn = (events: ReadonlyArray<object>, ready = () => Promise.resolve()): Turn => ({
  events,
  ready,
});

/** Answers the n-th Messages request with the n-th turn and records each request. */
async function scriptModel(context: BrowserContext, turns: ReadonlyArray<Turn>) {
  const requests: Array<MessagesRequest> = [];
  await context.route(MESSAGES_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
      return;
    }
    const index = requests.length;
    requests.push(decodeMessagesRequest(route.request().postData() ?? ""));
    const next = turns[index] ?? turn(textReply(`(no scripted turn ${index + 1})`));
    await next.ready();
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "cache-control": "no-cache",
      },
      // Anthropic streams name each SSE event after its payload `type`.
      body: next.events
        .map((event) => {
          const type =
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            typeof (event as { type: unknown }).type === "string"
              ? (event as { type: string }).type
              : "message";
          return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
        })
        .join(""),
    });
  });
  return { requests };
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  cache_creation: null,
  server_tool_use: null,
  service_tier: null,
};

let messageCount = 0;

const messageStart = () => ({
  type: "message_start",
  message: {
    id: `msg_${++messageCount}`,
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage,
    container: null,
    context_management: null,
  },
});

const messageEnd = (stopReason: string) => [
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null, container: null },
    usage,
    context_management: null,
  },
  { type: "message_stop" },
];

function toolUse(name: string, input: Readonly<Record<string, string>>) {
  return [
    messageStart(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${messageCount}`, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    ...messageEnd("tool_use"),
  ];
}

function textReply(text: string) {
  return [
    messageStart(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ...messageEnd("end_turn"),
  ];
}

function toolNames(request: MessagesRequest | undefined) {
  return (request?.tools ?? []).map((tool) => tool.name).sort();
}

/** The last tool result content in a request, as the model receives it. */
function lastToolResult(request: MessagesRequest | undefined) {
  const results = (request?.messages ?? [])
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .filter((part) => part.type === "tool_result");
  const last = results.at(-1);
  return typeof last?.content === "string" ? last.content : JSON.stringify(last ?? null);
}

// --- Workbench ---

/** Minimal shared-link payload: one text file (not a SQL notebook) as the editor. */
function sharedSeedPath() {
  const payload = JSON.stringify({
    files: [{ path: "/workspace/seed.txt", content: "seed\n" }],
    activeFile: "/workspace/seed.txt",
  });
  const encoded = btoa(unescape(encodeURIComponent(payload)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `/s/${encoded}`;
}

/**
 * Opens the app on a seeded shared route and waits until the shared workspace
 * load finished: preferred editor tab open, then the existing Loaded shared
 * workspace notification. Status bar alone is not readiness.
 */
async function openSharedApp(page: Page) {
  await page.goto(sharedSeedPath());
  await waitForWorkbench(page);
  // openPreferredFile runs before this notification; both must be present.
  await waitForNotification(page, "Loaded shared workspace: 1 file(s)", { timeout: 30_000 });
  await expect(page.getByRole("tab", { name: /seed\.txt/ })).toBeVisible();
}

/**
 * Runs a command from the palette. Some commands (chat model management)
 * become available only after startup applies the chat entitlement, so the
 * query repeats until the command is listed. It has no side effect until the
 * final click. Ranking depends on recent use, so the row is picked by name.
 */
async function runCommand(page: Page, title: string) {
  const row = page.getByRole("option", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("F1");
    await page.locator(".quick-input-widget input").last().fill(`>${title}`);
    await expect(row.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await row.first().click();
}

/**
 * Adds a provider's models through the workbench's Manage Models wizard, the
 * way a user does. One flow after workspace readiness, with no whole-flow retry.
 */
async function configureProvider(
  page: Page,
  { provider, apiKey }: { provider: string; apiKey: string },
) {
  await runCommand(page, "Chat: Manage Language Models");
  const input = page.locator(".quick-input-widget input").last();
  const step = (name: string, timeout = 10_000) =>
    expect(page.locator(".quick-input-title").filter({ hasText: name })).toBeVisible({ timeout });
  // The window renders before its menu reacts to clicks, so repeat until the
  // provider's entry opens the wizard.
  await expect(async () => {
    await page.getByText("Add Models", { exact: true }).click();
    const vendor = page.getByText(provider, { exact: true });
    await vendor.hover();
    await vendor.click();
    await step("Group Name", 2_000);
  }).toPass({ timeout: 30_000 });
  // The group name is pre-filled with the provider's name, so accept it as shown.
  await input.press("Enter");
  await step(`${provider}: API key`);
  await input.fill(apiKey);
  await input.press("Enter");

  // The window lists the provider's catalog models and stays open until dismissed.
  await expect(page.locator(`[aria-label*="from ${provider}"]`).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: /^Close Modal Editor/ }).click();
  await expect(page.locator(".monaco-modal-editor-block")).toBeHidden();
}

/**
 * `chat.tools.global.autoApprove` shows a one-time YOLO confirmation before
 * tools run. Accept it so Agent SQL/edit calls are not left pending approval.
 */
async function acceptGlobalAutoApproveIfAsked(page: Page) {
  const dialog = page.getByRole("dialog", { name: /Enable global auto approve/i });
  try {
    await expect(dialog).toBeVisible({ timeout: 15_000 });
  } catch {
    return;
  }
  await dialog.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/**
 * Focuses chat, confirms Agent mode (the only default participant), sends
 * `prompt`. `model` matches the model the picker must show.
 */
async function send(page: Page, prompt: string, model = "Claude") {
  await runCommand(page, "Chat: Focus on Chat View");
  await expect(page.locator(".interactive-input-part")).toBeAttached({ timeout: 15_000 });
  const selected = page.getByLabel(/^Set Agent/);
  if (!(await selected.isVisible().catch(() => false))) {
    await page.keyboard.press("Control+.");
    await page.locator(".action-widget").getByText("Agent", { exact: true }).click();
  }
  await expect(page.getByLabel(/^Set Agent/)).toBeAttached();
  // Pick the model from the chat picker when it is not the selected one. A
  // model missing from the picker fails here, before any request is sent.
  const picker = page.locator('[aria-label^="Models, "]').first();
  await expect(picker).toBeAttached({ timeout: 15_000 });
  if (!(await picker.getAttribute("aria-label"))?.includes(model)) {
    await picker.click();
    const direct = page.getByRole("menuitemradio", { name: model });
    if (await direct.isVisible().catch(() => false)) {
      await direct.click();
    } else {
      // The rest of the models sit in the "Other Models" submenu, which only
      // keyboard navigation opens here. Step to the focused item that matches.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      for (let step = 0; step < 60; step++) {
        const focused = await page.evaluate(() => {
          const rows = document.querySelectorAll(".action-widget .monaco-list-row.focused");
          return rows[rows.length - 1]?.textContent ?? "";
        });
        if (focused.includes(model)) break;
        await page.keyboard.press("ArrowDown");
      }
      await page.keyboard.press("Enter");
    }
  }
  await expect(page.locator(`[aria-label^="Models, "][aria-label*="${model}"]`)).toBeAttached({
    timeout: 15_000,
  });
  // Prefer session Auto Approve before the first tool call needs confirmation.
  const permissions = page.getByRole("button", { name: /Permission picker/i });
  if (await permissions.isVisible().catch(() => false)) {
    await permissions.click();
    const auto = page
      .locator(".action-widget")
      .getByText(/Auto Approve/i)
      .first();
    if (await auto.isVisible().catch(() => false)) await auto.click();
    await acceptGlobalAutoApproveIfAsked(page);
  }
  await runCommand(page, "Chat: Focus on Chat View");
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
}

function chatList(page: Page) {
  return page.locator(".part:has(.interactive-input-part)");
}

async function openWorkspaceFile(page: Page, name: string) {
  await page.keyboard.press("Control+P");
  await page.locator(".quick-input-widget input").fill(name);
  await page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: name })
    .first()
    .click();
}

const anthropicMock = {
  provider: "Anthropic",
  apiKey: "sk-ant-test-not-a-real-key",
};

/**
 * A real OpenCode call. It needs OPENCODE_API_KEY (from .env) and spends a
 * little of that account's balance, so it runs only when the key is set. It
 * uses a free model: if the picker shows any other model, the test fails before
 * the request is sent.
 */
test.describe("OpenCode Zen, live", () => {
  test.skip(!process.env.OPENCODE_API_KEY, "set OPENCODE_API_KEY in .env to run");
  test.setTimeout(180_000);

  test("a free OpenCode model answers a prompt", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await openSharedApp(page);
    const freeModel = "Free";
    await configureProvider(page, {
      provider: "OpenCode Zen",
      apiKey: process.env.OPENCODE_API_KEY ?? "",
    });
    // The answer (391) is not in the prompt, so it cannot come from the echoed
    // question. The status log shows whether the gateway accepted the request.
    const gateway: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes("opencode.ai/")) {
        gateway.push(`${response.status()} ${response.url()}`);
      }
    });
    await send(page, "What is 17 times 23? Answer with the number only.", freeModel);
    await expect.poll(() => gateway.length, { timeout: 120_000 }).toBeGreaterThan(0);
    console.log("opencode.ai responses:", gateway);
    await expect(chatList(page)).toContainText("391", { timeout: 120_000 });
  });
});

/**
 * A live OpenRouter call through the app, from the browser. It needs
 * OPENROUTER_API_KEY (from .env). The free models on OpenRouter cost nothing.
 */
test.describe("OpenRouter, live", () => {
  test.skip(!process.env.OPENROUTER_API_KEY, "set OPENROUTER_API_KEY in .env to run");
  test.setTimeout(180_000);

  test("a free OpenRouter model answers a prompt from the browser", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await openSharedApp(page);
    await configureProvider(page, {
      provider: "OpenRouter",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
    });
    const gateway: string[] = [];
    page.on("response", (response) => {
      if (response.url().includes("openrouter.ai/")) {
        gateway.push(`${response.status()} ${response.url()}`);
      }
    });
    const freeModel = "Flint (free)";
    await send(page, "What is 17 times 23? Answer with the number only.", freeModel);
    await expect.poll(() => gateway.length, { timeout: 120_000 }).toBeGreaterThan(0);
    console.log("openrouter.ai responses:", gateway);
    await expect(chatList(page)).toContainText("391", { timeout: 120_000 });
  });
});

test.describe("Language Models window", () => {
  test.setTimeout(120_000);

  test("offers no marketplace button for model-provider extensions", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await openSharedApp(page);
    await runCommand(page, "Chat: Manage Language Models");
    await expect(page.getByText("Add Models", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".models-browse-marketplace-button")).toBeHidden();
  });
});
