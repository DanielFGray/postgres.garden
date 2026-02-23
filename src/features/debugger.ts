import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
import { VSCodeService } from "../vscode/service";

const activateDebuggerFeature = (debuggerVscodeApi: typeof import("vscode")) => {
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

  debuggerVscodeApi.debug.registerDebugConfigurationProvider("javascript", {
    resolveDebugConfiguration() {
      return {
        name: "Test debugger",
        type: "javascript",
        request: "launch",
      };
    },
  });

  debuggerVscodeApi.debug.registerDebugAdapterDescriptorFactory("javascript", {
    async createDebugAdapterDescriptor() {
      const websocket = new WebSocket("ws://localhost:5555");

      await new Promise((resolve, reject) => {
        websocket.onopen = resolve;
        websocket.onerror = () =>
          reject(
            new Error("Unable to connect to debugger server. Run `npm run start:debugServer`"),
          );
      });

      websocket.send(
        JSON.stringify({
          main: "/workspace/test.js",
          files: {
            "/workspace/test.js": new TextDecoder().decode(
              await debuggerVscodeApi.workspace.fs.readFile(
                debuggerVscodeApi.Uri.file("/workspace/test.js"),
              ),
            ),
          },
        }),
      );

      const adapter = new WebsocketDebugAdapter(websocket);

      adapter.onDidSendMessage((message: vscode.DebugProtocolMessage) => {
        const msg = message as { type?: string; event?: string; body?: { output?: string } };
        if (msg.type === "event" && msg.event === "output") {
          console.log("OUTPUT", msg.body?.output);
        }
      });
      return new debuggerVscodeApi.DebugAdapterInlineImplementation(adapter);
    },
  });
};

export const DebuggerFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    yield* vscodeService.registerFileUrl(
      "./extension.js",
      `data:text/javascript;base64,${window.btoa("// nothing")}`,
    );
    yield* Effect.sync(() => {
      activateDebuggerFeature(vscodeService.api);
    });
  }),
);
