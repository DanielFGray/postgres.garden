// VS Code's Delayer.cancel() rejects its completionPromise with CancellationError.
// Several VS Code internals (e.g. notebookOutline.js) call trigger() without catching
// the returned promise, causing "Uncaught (in promise) Canceled" on every keystroke.
// Patch Delayer.prototype.cancel to attach a no-op catch before rejecting, so the
// promise always has a rejection handler regardless of whether the caller catches it.

// @ts-ignore internal VS Code module, resolved via package exports "./vscode/*"
import { Delayer } from "@codingame/monaco-vscode-api/vscode/vs/base/common/async";

type DelayerInternal = { cancel: () => void; completionPromise: Promise<unknown> | null };

const proto = Delayer.prototype as unknown as DelayerInternal;
const originalCancel = proto.cancel;
proto.cancel = function () {
  this.completionPromise?.catch(() => {});
  originalCancel.call(this);
};
