import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
import type * as vscode from "vscode";

const ext = registerExtension(
  {
    name: "debugger",
    publisher: "codingame",
    version: "1.0.0",
    engines: {
      vscode: "*",
    },
    // A browser field is mandatory for the extension to be flagged as `web`
    browser: "extension.js",
    contributes: {
      debuggers: [
        {
          type: "javascript",
          label: "Test",
          languages: ["javascript"],
        },
      ],
      breakpoints: [
        {
          language: "javascript",
        },
      ],
    },
  },
  ExtensionHostKind.LocalProcess,
);

ext.registerFileUrl("./extension.js", "data:text/javascript;base64," + window.btoa("// nothing"));

void ext.getApi().then((debuggerVscodeApi) => {
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
});
