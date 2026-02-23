import type * as vscode from "vscode";
import { Effect, Layer, Option, pipe } from "effect";
import { VSCodeService } from "../vscode/service";

export const TestingFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    const api = vscodeService.api;

    const testRe = /^([0-9]+)\s*([+*/-])\s*([0-9]+)\s*=\s*([0-9]+)/;
    const headingRe = /^(#+)\s*(.+)$/;

    const parseMarkdown = (
      text: string,
      events: {
        onTest(range: vscode.Range, a: number, operator: string, b: number, expected: number): void;
        onHeading(range: vscode.Range, name: string, depth: number): void;
      },
    ): void => {
      const lines = text.split("\n");

      lines.forEach((line, lineNo) => {
        const test = testRe.exec(line);
        if (test != null) {
          const [, a, operator, b, expected] = test;
          const range = new api.Range(
            new api.Position(lineNo, 0),
            new api.Position(lineNo, test[0].length),
          );
          events.onTest(range, Number(a), operator!, Number(b), Number(expected));
          return;
        }

        const heading = headingRe.exec(line);
        if (heading != null) {
          const [, pounds = "", name = ""] = heading;
          const range = new api.Range(
            new api.Position(lineNo, 0),
            new api.Position(lineNo, line.length),
          );
          events.onHeading(range, name, pounds.length);
        }
      });
    };

    const textDecoder = new TextDecoder("utf-8");

    type MarkdownTestData = TestFile | TestHeading | TestCase;

    const testData = new WeakMap<vscode.TestItem, MarkdownTestData>();

    let generationCounter = 0;

    const getContentFromFilesystem = async (uri: vscode.Uri): Promise<string> => {
      try {
        const rawContent = await api.workspace.fs.readFile(uri);
        return textDecoder.decode(rawContent);
      } catch (e) {
        console.warn(`Error providing tests for ${uri.fsPath}`, e);
        return "";
      }
    };

    class TestFile {
      public didResolve = false;

      public async updateFromDisk(
        controller: vscode.TestController,
        item: vscode.TestItem,
      ): Promise<void> {
        try {
          const uri = item.uri;
          if (!uri) {
            item.error = "Missing test item URI";
            return;
          }
          const content = await getContentFromFilesystem(uri);
          item.error = undefined;
          this.updateFromContents(controller, content, item);
        } catch (e) {
          item.error = (e as Error).stack;
        }
      }

      /**
       * Parses the tests from the input text, and updates the tests contained
       * by this file to be those from the text,
       */
      public updateFromContents(
        controller: vscode.TestController,
        content: string,
        item: vscode.TestItem,
      ): void {
        const ancestors = [{ item, children: [] as vscode.TestItem[] }];
        const thisGeneration = generationCounter++;
        this.didResolve = true;

        const ascend = (depth: number) => {
          while (ancestors.length > depth) {
            const finished = ancestors.pop()!;
            finished.item.children.replace(finished.children);
          }
        };

        parseMarkdown(content, {
          onTest: (range, a, operator, b, expected) => {
            const parent = ancestors[ancestors.length - 1]!;
            const data = new TestCase(a, operator as Operator, b, expected, thisGeneration);
            const id = `${item.uri?.toString() ?? ""}/${data.getLabel()}`;

            const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
            testData.set(tcase, data);
            tcase.range = range;
            parent.children.push(tcase);
          },

          onHeading: (range, name, depth) => {
            ascend(depth);
            const parent = ancestors[ancestors.length - 1]!;
            const id = `${item.uri?.toString() ?? ""}/${name}`;

            const thead = controller.createTestItem(id, name, item.uri);
            thead.range = range;
            testData.set(thead, new TestHeading(thisGeneration));
            parent.children.push(thead);
            ancestors.push({ item: thead, children: [] });
          },
        });

        ascend(0); // finish and assign children for all remaining items
      }
    }

    class TestHeading {
      constructor(public generation: number) {}
    }

    type Operator = "+" | "-" | "*" | "/";

    class TestCase {
      constructor(
        private readonly a: number,
        private readonly operator: Operator,
        private readonly b: number,
        private readonly expected: number,
        public generation: number,
      ) {}

      getLabel(): string {
        return `${this.a} ${this.operator} ${this.b} = ${this.expected}`;
      }

      async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));
        const actual = this.evaluate();
        const duration = Date.now() - start;

        if (actual === this.expected) {
          options.passed(item, duration);
        } else {
          const uri = item.uri;
          const range = item.range;
          if (!uri || !range) {
            options.errored(item, new api.TestMessage("Missing test location"), duration);
            return;
          }
          const message = api.TestMessage.diff(
            `Expected ${item.label}`,
            String(this.expected),
            String(actual),
          );
          message.location = new api.Location(uri, range);
          options.failed(item, message, duration);
        }
      }

      private evaluate() {
        switch (this.operator) {
          case "-":
            return this.a - this.b;
          case "+":
            return this.a + this.b;
          case "/":
            return Math.floor(this.a / this.b);
          case "*":
            return this.a * this.b;
        }
      }
    }

    const ctrl = yield* Effect.acquireRelease(
      Effect.sync(() => api.tests.createTestController("mathTestController", "Markdown Math")),
      (c) => Effect.sync(() => c.dispose()),
    );

    const fileChangedEmitter = yield* Effect.acquireRelease(
      Effect.sync(() => new api.EventEmitter<vscode.Uri>()),
      (e) => Effect.sync(() => e.dispose()),
    );

    const watchingTests = new Map<vscode.TestItem | "ALL", vscode.TestRunProfile | undefined>();

    function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
      const existing = controller.items.get(uri.toString());
      if (existing != null) {
        return { file: existing, data: testData.get(existing) as TestFile };
      }

      const file = controller.createTestItem(uri.toString(), uri.path.split("/").pop()!, uri);
      controller.items.add(file);

      const data = new TestFile();
      testData.set(file, data);

      file.canResolveChildren = true;
      return { file, data };
    }

    function gatherTestItems(collection: vscode.TestItemCollection) {
      const items: vscode.TestItem[] = [];
      collection.forEach((item) => items.push(item));
      return items;
    }

    function getWorkspaceTestPatterns() {
      if (api.workspace.workspaceFolders == null) {
        return [];
      }

      return api.workspace.workspaceFolders.map((workspaceFolder) => ({
        workspaceFolder,
        pattern: new api.RelativePattern(workspaceFolder, "**/*.md"),
      }));
    }

    async function findInitialFiles(
      controller: vscode.TestController,
      pattern: vscode.GlobPattern,
    ) {
      (await api.workspace.findFiles(pattern)).forEach((file) => {
        getOrCreateFile(controller, file);
      });
    }

    function startWatchingWorkspace(
      controller: vscode.TestController,
      emitter: vscode.EventEmitter<vscode.Uri>,
    ) {
      return getWorkspaceTestPatterns().map(({ pattern }) => {
        const watcher = api.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate((uri) => {
          getOrCreateFile(controller, uri);
          emitter.fire(uri);
        });
        watcher.onDidChange(async (uri) => {
          const { file, data } = getOrCreateFile(controller, uri);
          if (data.didResolve) {
            await data.updateFromDisk(controller, file);
          }
          emitter.fire(uri);
        });
        watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

        void findInitialFiles(controller, pattern);

        return watcher;
      });
    }

    const startTestRun = (request: vscode.TestRunRequest) => {
      const queue: { test: vscode.TestItem; data: TestCase }[] = [];
      const run = ctrl.createTestRun(request);
      // map of file uris to statements on each line:
      type OptionalStatementCoverage = vscode.StatementCoverage | undefined;
      const coveredLines = new Map</* file uri */ string, OptionalStatementCoverage[]>();

      const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
        await Array.from(tests).reduce(async (prev, test) => {
          await prev;
          if (request.exclude?.includes(test) ?? false) {
            return;
          }

          const data = testData.get(test);
          if (data instanceof TestCase) {
            run.enqueued(test);
            queue.push({ test, data });
          } else {
            if (data instanceof TestFile && !data.didResolve) {
              await data.updateFromDisk(ctrl, test);
            }

            await discoverTests(gatherTestItems(test.children));
          }

          if (test.uri != null && !coveredLines.has(test.uri.toString())) {
            try {
              const lines = (await getContentFromFilesystem(test.uri)).split("\n");
              coveredLines.set(
                test.uri.toString(),
                lines.map((lineText, lineNo) =>
                  lineText.trim().length > 0
                    ? new api.StatementCoverage(0, new api.Position(lineNo, 0))
                    : undefined,
                ),
              );
            } catch {
              // ignored
            }
          }
        }, Promise.resolve());
      };

      const runTestQueue = async () => {
        await queue.reduce(async (prev, { test, data }) => {
          await prev;
          run.appendOutput(`Running ${test.id}\r\n`);
          if (run.token.isCancellationRequested) {
            run.skipped(test);
          } else {
            run.started(test);
            await data.run(test, run);
          }

          const lineNo = test.range?.start.line;
          const testUri = test.uri?.toString();
          const fileCoverage =
            testUri && typeof lineNo === "number" ? coveredLines.get(testUri) : undefined;
          const lineInfo = typeof lineNo === "number" ? fileCoverage?.[lineNo] : undefined;
          if (lineInfo != null) {
            (lineInfo.executed as number)++;
          }

          run.appendOutput(`Completed ${test.id}\r\n`);
        }, Promise.resolve());

        Array.from(coveredLines.entries()).forEach(([uri, statements]) => {
          run.addCoverage(
            api.FileCoverage.fromDetails(
              api.Uri.parse(uri),
              statements.filter((s): s is vscode.StatementCoverage => s != null),
            ),
          );
        });

        run.end();
      };

      void discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(runTestQueue);
    };

    const runHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
      if (!(request.continuous ?? false)) {
        return startTestRun(request);
      }

      if (request.include === undefined) {
        watchingTests.set("ALL", request.profile);
        cancellation.onCancellationRequested(() => watchingTests.delete("ALL"));
      } else {
        const include = pipe(
          Option.fromNullable(request.include),
          Option.getOrElse(() => [] as vscode.TestItem[]),
        );
        include.forEach((item) => watchingTests.set(item, request.profile));
        cancellation.onCancellationRequested(() =>
          include.forEach((item) => watchingTests.delete(item)),
        );
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        fileChangedEmitter.event((uri) => {
          if (watchingTests.has("ALL")) {
            startTestRun(
              new api.TestRunRequest(undefined, undefined, watchingTests.get("ALL"), true),
            );
            return;
          }

          const include: vscode.TestItem[] = [];
          let profile: vscode.TestRunProfile | undefined;
          Array.from(watchingTests.entries()).forEach(([item, thisProfile]) => {
            const cast = item as vscode.TestItem;
            if (cast.uri?.toString() === uri.toString()) {
              include.push(cast);
              profile = thisProfile;
            }
          });

          if (include.length > 0) {
            startTestRun(new api.TestRunRequest(include, undefined, profile, true));
          }
        }),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );

    ctrl.refreshHandler = async () => {
      await Promise.all(
        getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(ctrl, pattern)),
      );
    };

    ctrl.createRunProfile("Run Tests", api.TestRunProfileKind.Run, runHandler, true, undefined, true);

    ctrl.resolveHandler = async (item) => {
      if (item == null) {
        startWatchingWorkspace(ctrl, fileChangedEmitter);
        return;
      }

      const data = testData.get(item);
      if (data instanceof TestFile) {
        await data.updateFromDisk(ctrl, item);
      }
    };

    function updateNodeForDocument(e: vscode.TextDocument) {
      if (e.uri.scheme !== "file") {
        return;
      }

      if (!e.uri.path.endsWith(".md")) {
        return;
      }

      const { file, data } = getOrCreateFile(ctrl, e.uri);
      data.updateFromContents(ctrl, e.getText(), file);
    }

    api.workspace.textDocuments.forEach((document) => {
      updateNodeForDocument(document);
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => api.workspace.onDidOpenTextDocument(updateNodeForDocument)),
      (d) => Effect.sync(() => d.dispose()),
    );

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        api.workspace.onDidChangeTextDocument((e) => updateNodeForDocument(e.document)),
      ),
      (d) => Effect.sync(() => d.dispose()),
    );
  }),
);
