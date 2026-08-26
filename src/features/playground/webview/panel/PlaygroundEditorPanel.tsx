import * as Effect from "effect/Effect";
import { DateTime } from "effect";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiRequest, sendCommand, sendMessage } from "../api";
import type { Playground } from "../../types";
import * as S from "effect/Schema";

type PlaygroundResponse = Playground & {
  stars?: string;
  is_starred?: boolean;
};

const BridgeMessage = S.Union(
  S.Struct({ type: S.Literal("setPlaygroundId"), data: S.Struct({ playgroundId: S.String }) }),
  S.Struct({ type: S.Literal("clearPlayground") }),
  S.Struct({ type: S.Literal("triggerSave") }),
);

const [playground, setPlayground] = createSignal<Playground | null>(null);
const [isDirty, setIsDirty] = createSignal(false);
const [saveStatus, setSaveStatus] = createSignal({ message: "", type: "" });
const [starInfo, setStarInfo] = createSignal<{ starred: boolean; count: number }>({
  starred: false,
  count: 0,
});

function showSaveStatus(message: string, type: string) {
  setSaveStatus({ message, type });

  if (type === "success") {
    Effect.runFork(
      Effect.sleep(3000).pipe(
        Effect.tap(() => Effect.sync(() => setSaveStatus({ message: "", type: "" }))),
      ),
    );
  }
}

function doSave() {
  if (!isDirty()) return;

  const pg = playground();
  if (!pg) return;
  setSaveStatus({ message: "Saving...", type: "info" });

  Effect.runFork(
    apiRequest<Playground>(`/api/playgrounds/${pg.hash}`, "PATCH", {
      name: pg.name,
      description: pg.description,
      privacy: pg.privacy,
    }).pipe(
      Effect.tap((updated) =>
        Effect.sync(() => {
          setPlayground(updated);
          setIsDirty(false);
          showSaveStatus("Saved", "success");
        }),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => showSaveStatus(error.message || "Save failed", "error")),
      ),
    ),
  );
}

function loadPlayground(playgroundId: string) {
  Effect.runFork(
    apiRequest<PlaygroundResponse>(`/api/playgrounds/${playgroundId}`, "GET").pipe(
      Effect.tap((data) =>
        Effect.sync(() => {
          setPlayground(data);
          setIsDirty(false);
          setStarInfo({ starred: data.is_starred ?? false, count: Number(data.stars ?? 0) });
        }),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          Effect.runFork(Effect.logError("Failed to load playground:", error));
          showSaveStatus("Failed to load", "error");
        }),
      ),
    ),
  );
}

function handleMetadataChange(field: "name" | "description" | "privacy", value: string) {
  const current = playground();
  if (!current) return;
  setPlayground({ ...current, [field]: value });
  setIsDirty(true);
}

function handleToggleStar() {
  if (!playground()) return;
  const current = starInfo();
  // Optimistic update
  setStarInfo({
    starred: !current.starred,
    count: current.starred ? current.count - 1 : current.count + 1,
  });

  Effect.runFork(
    apiRequest<{ starred: boolean }>(`/api/playgrounds/${playground()!.hash}/star`, "POST").pipe(
      // Reconcile with server
      Effect.tap((result) =>
        Effect.sync(() => setStarInfo((info) => ({ ...info, starred: result.starred }))),
      ),
      // Revert optimistic update
      Effect.catchAll(() => Effect.sync(() => setStarInfo(current))),
    ),
  );
}

function handleFork() {
  const pg = playground();
  if (!pg) return;
  Effect.runFork(
    apiRequest<Playground>(`/api/playgrounds/${pg.hash}/fork`, "POST").pipe(
      Effect.tap((fork) => Effect.sync(() => sendCommand("fork", { hash: fork.hash }))),
      Effect.catchAll((error) => Effect.logError("Failed to fork:", error)),
    ),
  );
}

export const PlaygroundEditorPanel = () => {
  const handleHostMessage = (event: MessageEvent) => {
    const parsed = S.decodeUnknownOption(BridgeMessage)(event.data);
    if (parsed._tag === "None") return;
    const message = parsed.value;

    switch (message.type) {
      case "setPlaygroundId": {
        loadPlayground(message.data.playgroundId);
        break;
      }
      case "clearPlayground":
        setPlayground(null);
        setIsDirty(false);
        setStarInfo({ starred: false, count: 0 });
        break;
      case "triggerSave":
        doSave();
        break;
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      doSave();
    }
  };

  window.addEventListener("message", handleHostMessage);
  document.addEventListener("keydown", handleKeydown);
  onCleanup(() => {
    window.removeEventListener("message", handleHostMessage);
    document.removeEventListener("keydown", handleKeydown);
  });

  // Signal that webview JS is ready
  sendMessage({ type: "initialized" });

  return (
    <Show when={playground()} fallback={<div class="loading">No playground loaded</div>}>
      {(pg) => (
        <>
          <Show when={saveStatus().message}>
            <div class={`save-status save-status-${saveStatus().type}`}>{saveStatus().message}</div>
          </Show>

          <div class="metadata-panel">
            <div class="form-group">
              <label for="name">Name</label>
              <input
                type="text"
                id="name"
                placeholder="Playground name"
                value={pg().name || ""}
                onInput={(e) => handleMetadataChange("name", e.currentTarget.value)}
              />
            </div>

            <div class="form-group">
              <label for="privacy">Privacy</label>
              <select
                id="privacy"
                value={pg().privacy}
                onChange={(e) => handleMetadataChange("privacy", e.currentTarget.value)}
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
                value={pg().description || ""}
                onInput={(e) => handleMetadataChange("description", e.currentTarget.value)}
              />
            </div>

            <div class="action-row">
              <button
                class={`action-pill ${starInfo().starred ? "action-pill--starred" : ""}`}
                title={starInfo().starred ? "Unstar" : "Star"}
                onClick={handleToggleStar}
              >
                <i
                  class={`codicon ${starInfo().starred ? "codicon-star-full" : "codicon-star-empty"}`}
                />
                <span class="action-pill__label">{starInfo().starred ? "Starred" : "Star"}</span>
                <Show when={starInfo().count > 0}>
                  <span class="action-pill__count">{starInfo().count}</span>
                </Show>
              </button>

              <button class="action-pill" title="Fork this playground" onClick={handleFork}>
                <i class="codicon codicon-repo-forked" />
                <span class="action-pill__label">Fork</span>
              </button>
            </div>

            <div class="form-group">
              <span class="meta-text">
                Created {DateTime.toDate(DateTime.unsafeMake(pg().created_at)).toLocaleDateString()}
              </span>
            </div>

            <Show when={isDirty()}>
              <div class="dirty-indicator">
                <i class="codicon codicon-circle-filled" /> Unsaved changes (Ctrl+S)
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
};
