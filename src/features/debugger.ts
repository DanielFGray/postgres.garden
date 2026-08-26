import { Effect, Layer, Runtime } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";
import { VSCodeService } from "../vscode/service";

class DebuggerConnectionError extends S.TaggedError<DebuggerConnectionError>()(
  "DebuggerConnectionError",
  { message: S.String },
) {}

const activateDebuggerFeature = (debuggerVscodeApi: typeof import("vscode")): vscode.Disposable => {
  class WebsocketDebugAdapter implements vscode.DebugAdapter {
    constructor(private websocket: WebSocket) {
      websocket.onmessage = (message) => {
        this._onDidSendMessage.fire(
          JSON.parse(message.data as string) as vscode.DebugProtocolMessage,
        );
      };
    }

    _onDidSendMessage = new debuggerVscodeApi.EventEmitter<vscode.DebugProtocolMessage>();
    onDidSendMessage = this._onDidSendMessage.event;

    handleMessage(message: vscode.DebugProtocolMessage): void {
      this.websocket.send(JSON.stringify(message));
    }

    dispose() {
      this.websocket.close();
    }
  }

  const configurationProvider = debuggerVscodeApi.debug.registerDebugConfigurationProvider("javascript", {
    resolveDebugConfiguration() {
      return {
        name: "Test debugger",
        type: "javascript",
        request: "launch",
      };
    },
  });

  const adapterDescriptorFactory = debuggerVscodeApi.debug.registerDebugAdapterDescriptorFactory("javascript", {
    createDebugAdapterDescriptor() {
      return Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* Effect.runtime<never>();
          const websocket = new WebSocket("ws://localhost:5555");

          yield* Effect.async<void, DebuggerConnectionError>((resume) => {
            websocket.onopen = () => resume(Effect.void);
            websocket.onerror = () =>
              resume(
                Effect.fail(
                  new DebuggerConnectionError({
                    message:
                      "Unable to connect to debugger server. Run `npm run start:debugServer`",
                  }),
                ),
              );
          });

          const fileBytes = yield* Effect.promise(() =>
            debuggerVscodeApi.workspace.fs.readFile(
              debuggerVscodeApi.Uri.file("/workspace/test.js"),
            ),
          );

          const payload = yield* S.encode(S.parseJson(S.Unknown))({
            main: "/workspace/test.js",
            files: {
              "/workspace/test.js": new TextDecoder().decode(fileBytes),
            },
          });
          websocket.send(payload);

          const adapter = new WebsocketDebugAdapter(websocket);

          adapter.onDidSendMessage((message: vscode.DebugProtocolMessage) => {
            const msg = message as { type?: string; event?: string; body?: { output?: string } };
            if (msg.type === "event" && msg.event === "output") {
              Runtime.runSync(runtime)(Effect.log("OUTPUT", msg.body?.output));
            }
          });
          return new debuggerVscodeApi.DebugAdapterInlineImplementation(adapter);
        }),
      );
    },
  });

  return debuggerVscodeApi.Disposable.from(configurationProvider, adapterDescriptorFactory);
};

export const DebuggerFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    yield* vscodeService.registerFileUrl(
      "./extension.js",
      `data:text/javascript;base64,${window.btoa("// nothing")}`,
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => activateDebuggerFeature(vscodeService.api)),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );
  }),
);
