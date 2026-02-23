import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest, sendCommand, sendMessage } from "../api";
import type { Playground } from "../../types";

type PlaygroundResponse = Playground & {
  stars?: string;
  is_starred?: boolean;
};

type BridgeMessage = {
  type: string;
  data?: Record<string, unknown>;
};

// Atoms
const playgroundAtom = Atom.make<Playground | null>(null);
const isDirtyAtom = Atom.make(false);
const saveStatusAtom = Atom.make({ message: "", type: "" });
const starInfoAtom = Atom.make<{ starred: boolean; count: number }>({
  starred: false,
  count: 0,
});

let initialized = false;

export const PlaygroundEditorPanel = () =>
  Effect.gen(function* () {
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

      function doSave() {
        const dirty = registry.get(isDirtyAtom);
        if (!dirty) return;

        registry.set(saveStatusAtom, { message: "Saving...", type: "info" });
        const pg = registry.get(playgroundAtom);
        if (!pg) return;

        Effect.runFork(
          apiRequest<Playground>(`/api/playgrounds/${pg.hash}`, "PATCH", {
            name: pg.name,
            description: pg.description,
            privacy: pg.privacy,
          }).pipe(
            Effect.tap((updated) =>
              Effect.sync(() => {
                registry.set(playgroundAtom, updated);
                registry.set(isDirtyAtom, false);
                showSaveStatus("Saved", "success");
              }),
            ),
            Effect.catchAll((error) =>
              Effect.sync(() => {
                showSaveStatus(error.message || "Save failed", "error");
              }),
            ),
          ),
        );
      }

      function loadPlayground(playgroundId: string) {
        Effect.runFork(
          apiRequest<PlaygroundResponse>(`/api/playgrounds/${playgroundId}`, "GET").pipe(
            Effect.tap((data) =>
              Effect.sync(() => {
                registry.set(playgroundAtom, data);
                registry.set(isDirtyAtom, false);
                registry.set(starInfoAtom, {
                  starred: data.is_starred ?? false,
                  count: Number(data.stars ?? 0),
                });
              }),
            ),
            Effect.catchAll((error) =>
              Effect.sync(() => {
                console.error("Failed to load playground:", error);
                showSaveStatus("Failed to load", "error");
              }),
            ),
          ),
        );
      }

      window.addEventListener("message", (event) => {
        const message = event.data as BridgeMessage;

        switch (message.type) {
          case "setPlaygroundId": {
            const id = message.data?.playgroundId;
            if (typeof id === "string") {
              loadPlayground(id);
            }
            break;
          }
          case "clearPlayground":
            registry.set(playgroundAtom, null);
            registry.set(isDirtyAtom, false);
            registry.set(starInfoAtom, { starred: false, count: 0 });
            break;
          case "triggerSave":
            doSave();
            break;
        }
      });

      document.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          doSave();
        }
      });

      // Signal that webview JS is ready
      sendMessage({ type: "initialized" });
    }

    const pg = yield* Atom.get(playgroundAtom);
    const isDirty = yield* Atom.get(isDirtyAtom);
    const saveStatus = yield* Atom.get(saveStatusAtom);
    const starInfo = yield* Atom.get(starInfoAtom);

    if (!pg) {
      return <div class="loading">No playground loaded</div>;
    }

    function handleMetadataChange(
      field: "name" | "description" | "privacy",
      value: string,
    ) {
      const current = registry.get(playgroundAtom);
      if (!current) return;
      registry.set(playgroundAtom, { ...current, [field]: value });
      registry.set(isDirtyAtom, true);
    }

    function handleToggleStar() {
      if (!pg) return;
      const current = registry.get(starInfoAtom);
      // Optimistic update
      registry.set(starInfoAtom, {
        starred: !current.starred,
        count: current.starred ? current.count - 1 : current.count + 1,
      });

      Effect.runFork(
        apiRequest<{ starred: boolean }>(
          `/api/playgrounds/${pg.hash}/star`,
          "POST",
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              // Reconcile with server
              const info = registry.get(starInfoAtom);
              registry.set(starInfoAtom, {
                ...info,
                starred: result.starred,
              });
            }),
          ),
          Effect.catchAll(() =>
            Effect.sync(() => {
              // Revert optimistic update
              registry.set(starInfoAtom, current);
            }),
          ),
        ),
      );
    }

    function handleFork() {
      if (!pg) return;
      Effect.runFork(
        apiRequest<Playground>(`/api/playgrounds/${pg.hash}/fork`, "POST").pipe(
          Effect.tap((fork) =>
            Effect.sync(() => {
              sendCommand("fork", { hash: fork.hash });
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.error("Failed to fork:", error);
            }),
          ),
        ),
      );
    }

    return (
      <>
        {saveStatus.message && (
          <div class={`save-status save-status-${saveStatus.type}`}>
            {saveStatus.message}
          </div>
        )}

        <div class="metadata-panel">
          <div class="form-group">
            <label for="name">Name</label>
            <input
              type="text"
              id="name"
              placeholder="Playground name"
              value={pg.name || ""}
              onInput={(e: Event) =>
                handleMetadataChange(
                  "name",
                  (e.target as HTMLInputElement).value,
                )
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

          <div class="form-group">
            <label for="description">Description</label>
            <textarea
              id="description"
              placeholder="Add a description..."
              value={pg.description || ""}
              onInput={(e: Event) =>
                handleMetadataChange(
                  "description",
                  (e.target as HTMLTextAreaElement).value,
                )
              }
            ></textarea>
          </div>

          <div class="action-row">
            <button
              class={`action-pill ${starInfo.starred ? "action-pill--starred" : ""}`}
              title={starInfo.starred ? "Unstar" : "Star"}
              onClick={handleToggleStar}
            >
              <i
                class={`codicon ${starInfo.starred ? "codicon-star-full" : "codicon-star-empty"}`}
              ></i>
              <span class="action-pill__label">
                {starInfo.starred ? "Starred" : "Star"}
              </span>
              {starInfo.count > 0 && (
                <span class="action-pill__count">{starInfo.count}</span>
              )}
            </button>

            <button
              class="action-pill"
              title="Fork this playground"
              onClick={handleFork}
            >
              <i class="codicon codicon-repo-forked"></i>
              <span class="action-pill__label">Fork</span>
            </button>
          </div>

          <div class="form-group">
            <span class="meta-text">
              Created {new Date(pg.created_at).toLocaleDateString()}
            </span>
          </div>

          {isDirty && (
            <div class="dirty-indicator">
              <i class="codicon codicon-circle-filled"></i> Unsaved changes
              (Ctrl+S)
            </div>
          )}
        </div>
      </>
    );
  });
