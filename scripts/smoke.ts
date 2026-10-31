/**
 * Loads the running app in a headless browser and reports what its console
 * said, grouped by message so one error repeated fifteen times reads as one
 * line. Checking the console after a change is in CLAUDE.md; this does it
 * without a browser window that takes the keyboard focus.
 *
 *   bun smoke                                 # http://localhost:3000, 20s
 *   bun smoke http://localhost:3000 30        # explicit url and settle time
 *
 * It reports rather than gates. VS Code internals reject a cancelled promise
 * that no application change can reach, so a human reads the tally. A page
 * that does not load fails the run.
 */
import { chromium, type Browser, type ConsoleMessage } from "@playwright/test";
import { Data, Effect } from "effect";

const url = process.argv[2] ?? "http://localhost:3000";
const settleSeconds = Number(process.argv[3] ?? 20);

class PageNotLoaded extends Data.TaggedError("PageNotLoaded")<{
  readonly url: string;
  readonly detail: string;
}> {}

/**
 * Playwright's own chromium build when it has been downloaded, else the Chrome
 * already on the machine, so a smoke test needs no 170MB fetch.
 */
const openBrowser = Effect.acquireRelease(
  Effect.promise<Browser>(() =>
    chromium
      .launch({ headless: true })
      .catch(() => chromium.launch({ headless: true, channel: "chrome" })),
  ),
  (browser) => Effect.promise(() => browser.close()),
);

const smoke = Effect.gen(function* () {
  const browser = yield* openBrowser;
  const page = yield* Effect.promise(() => browser.newPage());

  const errors: Array<string> = [];
  const warnings: Array<string> = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  page.on("pageerror", (error: Error) => errors.push(`uncaught: ${error.message}`));
  page.on("requestfailed", (request) =>
    errors.push(`request failed: ${request.failure()?.errorText} ${request.url()}`),
  );

  const status = yield* Effect.tryPromise({
    try: () => page.goto(url, { waitUntil: "domcontentloaded" }).then((r) => r?.status() ?? 0),
    catch: (cause) => new PageNotLoaded({ url, detail: String(cause) }),
  });
  if (status === 0 || status >= 400) {
    return yield* new PageNotLoaded({ url, detail: `answered ${status}` });
  }

  // The workbench keeps registering views and extensions well after the
  // document is ready, and that is where most of the console traffic happens.
  yield* Effect.sleep(`${settleSeconds} seconds`);
  const title = yield* Effect.promise(() => page.title());

  yield* Effect.log(
    [
      `${url} → HTTP ${status}, title "${title}", settled ${settleSeconds}s`,
      `${errors.length} console errors, ${warnings.length} warnings`,
      ...tally("errors", errors),
      ...tally("warnings", warnings),
    ].join("\n"),
  );
}).pipe(Effect.scoped);

/** One line per distinct message, with how many times it appeared. */
const tally = (label: string, lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (lines.length === 0) return [];
  const counts = new Map<string, number>();
  for (const line of lines) {
    // Ids differ between otherwise identical messages.
    const key = line.replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, "<id>").slice(0, 160);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [
    `--- ${label} ---`,
    ...[...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => `${String(count).padStart(4)}  ${text}`),
  ];
};

await Effect.runPromise(smoke);
