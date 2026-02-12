import { signal, computed, effect } from "@preact/signals";
import type { PlaygroundListItem, ExtensionToViewMessage } from "../../types";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

// State
const playgrounds = signal<PlaygroundListItem[]>([]);
const searchQuery = signal("");

// Computed filtered playgrounds
const filteredPlaygrounds = computed(() => {
  const query = searchQuery.value.toLowerCase();
  if (!query) return playgrounds.value;

  return playgrounds.value.filter(
    (p) =>
      (p.name && p.name.toLowerCase().includes(query)) ||
      (p.description && p.description.toLowerCase().includes(query)),
  );
});

// Listen for messages from extension
window.addEventListener("message", (event) => {
  const message = event.data as ExtensionToViewMessage;
  console.log("Received message:", message);

  switch (message.type) {
    case "playgroundsList":
      playgrounds.value = message.data || [];
      break;
    case "playgroundCreated":
    case "playgroundDeleted":
      // Request refresh
      vscode.postMessage({ type: "loadPlaygrounds" });
      break;
    case "error":
      console.error("Error from extension:", message.data?.message);
      break;
  }
});

// Request initial data on mount
effect(() => {
  vscode.postMessage({ type: "loadPlaygrounds" });
});

function handleCreate() {
  const name = prompt("Playground name:");
  if (name) {
    vscode.postMessage({
      type: "createPlayground",
      data: { name },
    });
  }
}

function handleSearch(e: Event) {
  const target = e.target as HTMLInputElement;
  searchQuery.value = target.value;
}

function handleOpen(hash: string) {
  vscode.postMessage({ type: "openPlayground", data: { hash } });
}

function handleFork(e: Event, hash: string) {
  e.stopPropagation();
  vscode.postMessage({ type: "forkPlayground", data: { hash } });
}

function handleDelete(e: Event, hash: string) {
  e.stopPropagation();
  if (confirm("Delete this playground?")) {
    vscode.postMessage({ type: "deletePlayground", data: { hash } });
  }
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString();
}

function PlaygroundItem({ playground }: { playground: PlaygroundListItem }) {
  return (
    <div class="playground-item" onClick={() => handleOpen(playground.hash)}>
      <div class="playground-header">
        <span class="playground-name">{playground.name || "Untitled"}</span>
        <span class={`privacy-badge privacy-${playground.privacy}`}>
          {playground.privacy}
        </span>
      </div>

      {playground.description && (
        <div class="playground-description">{playground.description}</div>
      )}

      <div class="playground-footer">
        <span class="playground-date">{formatDate(playground.updated_at)}</span>
        <div class="playground-actions">
          <button
            class="icon-button action-open"
            title="Open"
            onClick={() => handleOpen(playground.hash)}
          >
            <i class="codicon codicon-go-to-file"></i>
          </button>
          <button
            class="icon-button action-fork"
            title="Fork"
            onClick={(e) => handleFork(e, playground.hash)}
          >
            <i class="codicon codicon-repo-forked"></i>
          </button>
          <button
            class="icon-button action-delete"
            title="Delete"
            onClick={(e) => handleDelete(e, playground.hash)}
          >
            <i class="codicon codicon-trash"></i>
          </button>
        </div>
      </div>
    </div>
  );
}

export function PlaygroundListView() {
  return (
    <>
      <div class="header">
        <h3>Playgrounds</h3>
        <button
          class="icon-button"
          id="create-btn"
          title="Create Playground"
          onClick={handleCreate}
        >
          <i class="codicon codicon-add"></i>
        </button>
      </div>

      <div class="search-container">
        <input
          type="text"
          id="search"
          placeholder="Search playgrounds..."
          onInput={handleSearch}
        />
      </div>

      <div class="playground-list">
        {filteredPlaygrounds.value.length === 0 ? (
          <div class="empty">No playgrounds found</div>
        ) : (
          filteredPlaygrounds.value.map((playground) => (
            <PlaygroundItem key={playground.hash} playground={playground} />
          ))
        )}
      </div>
    </>
  );
}
