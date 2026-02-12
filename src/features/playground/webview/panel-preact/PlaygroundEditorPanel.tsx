import { signal, effect } from "@preact/signals";
import type { Playground, ExtensionToPanelMessage } from "../../types";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

// State
const playground = signal<Playground | null>(null);
const isDirty = signal(false);
const saveStatus = signal({ message: "", type: "" });

// Listen for messages from extension
window.addEventListener("message", (event) => {
  const message = event.data as ExtensionToPanelMessage;

  switch (message.type) {
    case "loadPlayground":
      playground.value = message.data;
      isDirty.value = false;
      break;
    case "saved":
      isDirty.value = false;
      showSaveStatus("Saved", "success");
      break;
    case "error":
      showSaveStatus(message.data?.message || "Error", "error");
      break;
  }
});

// Signal that webview is ready
effect(() => {
  vscode.postMessage({ type: "initialized" });
});

function showSaveStatus(message: string, type: string) {
  saveStatus.value = { message, type };

  if (type === "success") {
    setTimeout(() => {
      saveStatus.value = { message: "", type: "" };
    }, 3000);
  }
}

function handleMetadataChange(
  field: "name" | "description" | "privacy",
  value: string,
) {
  isDirty.value = true;
  showSaveStatus("Saving...", "info");

  const data: Record<string, string | null | undefined> = {
    name: playground.value?.name,
    description: playground.value?.description,
    privacy: playground.value?.privacy,
  };
  data[field] = value;

  vscode.postMessage({
    type: "updateMetadata",
    data,
  });
}

function handleSave() {
  if (!isDirty.value) return;

  showSaveStatus("Saving...", "info");
  vscode.postMessage({
    type: "updateMetadata",
    data: {
      name: playground.value?.name,
      description: playground.value?.description,
      privacy: playground.value?.privacy,
    },
  });
}

function handleFork() {
  vscode.postMessage({ type: "fork" });
}

function handleKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    handleSave();
  }
}

// Keyboard shortcuts
effect(() => {
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
});

export function PlaygroundEditorPanel() {
  if (!playground.value) {
    return <div class="loading">Loading playground...</div>;
  }

  return (
    <>
      <div class="toolbar">
        <div class="toolbar-left">
          <button
            class="button"
            title="Save (Ctrl+S)"
            onClick={handleSave}
            disabled={!isDirty.value}
          >
            <i class="codicon codicon-save"></i>
            Save
          </button>
          <button
            class="button"
            title="Fork this playground"
            onClick={handleFork}
          >
            <i class="codicon codicon-repo-forked"></i>
            Fork
          </button>
        </div>
        <div class="toolbar-right">
          {saveStatus.value.message && (
            <span class={`save-status save-status-${saveStatus.value.type}`}>
              {saveStatus.value.message}
            </span>
          )}
        </div>
      </div>

      <div class="metadata-panel">
        <div class="form-group">
          <label for="name">Name</label>
          <input
            type="text"
            id="name"
            placeholder="Playground name"
            value={playground.value.name || ""}
            onInput={(e) =>
              handleMetadataChange("name", (e.target as HTMLInputElement).value)
            }
          />
        </div>
        <div class="form-group">
          <label for="privacy">Privacy</label>
          <select
            id="privacy"
            value={playground.value.privacy}
            onChange={(e) =>
              handleMetadataChange(
                "privacy",
                (e.target as HTMLSelectElement).value,
              )
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
            <option value="secret">Secret</option>
          </select>
        </div>
      </div>

      <div class="description-container">
        <label for="description">Description</label>
        <textarea
          id="description"
          placeholder="Add a description for this playground..."
          value={playground.value.description || ""}
          onInput={(e) =>
            handleMetadataChange(
              "description",
              (e.target as HTMLTextAreaElement).value,
            )
          }
        ></textarea>
      </div>
    </>
  );
}
