import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import type { Playground, ExtensionToPanelMessage } from "../../types";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

// Atoms
const playgroundAtom = Atom.make<Playground | null>(null);
const isDirtyAtom = Atom.make(false);
const saveStatusAtom = Atom.make({ message: "", type: "" });

let initialized = false;

export const PlaygroundEditorPanel = () => Effect.gen(function* () {
  const registry = yield* AtomRegistry.AtomRegistry;

  if (!initialized) {
    initialized = true;

    function showSaveStatus(message: string, type: string) {
      registry.set(saveStatusAtom, { message, type });

      if (type === "success") {
        setTimeout(() => {
          registry.set(saveStatusAtom, { message: "", type: "" });
        }, 3000);
      }
    }

    window.addEventListener("message", (event) => {
      const message = event.data as ExtensionToPanelMessage;

      switch (message.type) {
        case "loadPlayground":
          registry.set(playgroundAtom, message.data);
          registry.set(isDirtyAtom, false);
          break;
        case "saved":
          registry.set(isDirtyAtom, false);
          showSaveStatus("Saved", "success");
          break;
        case "error":
          showSaveStatus(message.data?.message || "Error", "error");
          break;
      }
    });

    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const dirty = registry.get(isDirtyAtom);
        if (!dirty) return;

        registry.set(saveStatusAtom, { message: "Saving...", type: "info" });
        const pg = registry.get(playgroundAtom);
        vscode.postMessage({
          type: "updateMetadata",
          data: {
            name: pg?.name,
            description: pg?.description,
            privacy: pg?.privacy,
          },
        });
      }
    });

    // Signal that webview is ready
    vscode.postMessage({ type: "initialized" });
  }

  const pg = yield* Atom.get(playgroundAtom);
  const isDirty = yield* Atom.get(isDirtyAtom);
  const saveStatus = yield* Atom.get(saveStatusAtom);

  if (!pg) {
    return <div class="loading">Loading playground...</div>;
  }

  function handleMetadataChange(
    field: "name" | "description" | "privacy",
    value: string,
  ) {
    registry.set(isDirtyAtom, true);
    registry.set(saveStatusAtom, { message: "Saving...", type: "info" });

    const current = registry.get(playgroundAtom);
    const data: Record<string, string | null | undefined> = {
      name: current?.name,
      description: current?.description,
      privacy: current?.privacy,
    };
    data[field] = value;

    vscode.postMessage({
      type: "updateMetadata",
      data,
    });
  }

  function handleSave() {
    const dirty = registry.get(isDirtyAtom);
    if (!dirty) return;

    registry.set(saveStatusAtom, { message: "Saving...", type: "info" });
    const current = registry.get(playgroundAtom);
    vscode.postMessage({
      type: "updateMetadata",
      data: {
        name: current?.name,
        description: current?.description,
        privacy: current?.privacy,
      },
    });
  }

  function handleFork() {
    vscode.postMessage({ type: "fork" });
  }

  return (
    <>
      <div class="toolbar">
        <div class="toolbar-left">
          <button
            class="button"
            title="Save (Ctrl+S)"
            onClick={handleSave}
            disabled={!isDirty}
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
          {saveStatus.message && (
            <span class={`save-status save-status-${saveStatus.type}`}>
              {saveStatus.message}
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
            value={pg.name || ""}
            onInput={(e: Event) =>
              handleMetadataChange("name", (e.target as HTMLInputElement).value)
            }
          />
        </div>
        <div class="form-group">
          <label for="privacy">Privacy</label>
          <select
            id="privacy"
            value={pg.privacy}
            onChange={(e: Event) =>
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
          value={pg.description || ""}
          onInput={(e: Event) =>
            handleMetadataChange(
              "description",
              (e.target as HTMLTextAreaElement).value,
            )
          }
        ></textarea>
      </div>
    </>
  );
});
