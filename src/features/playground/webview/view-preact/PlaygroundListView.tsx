import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import type { PlaygroundListItem, ExtensionToViewMessage } from "../../types";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

// Atoms
const playgroundsAtom = Atom.make<PlaygroundListItem[]>([]);
const searchQueryAtom = Atom.make("");

function handleCreate() {
  const name = prompt("Playground name:");
  if (name) {
    vscode.postMessage({
      type: "createPlayground",
      data: { name },
    });
  }
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
        <span class={`privacy-badge privacy-${playground.privacy}`}>{playground.privacy}</span>
      </div>

      {playground.description && <div class="playground-description">{playground.description}</div>}

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
            onClick={(e: Event) => handleFork(e, playground.hash)}
          >
            <i class="codicon codicon-repo-forked"></i>
          </button>
          <button
            class="icon-button action-delete"
            title="Delete"
            onClick={(e: Event) => handleDelete(e, playground.hash)}
          >
            <i class="codicon codicon-trash"></i>
          </button>
        </div>
      </div>
    </div>
  );
}

let initialized = false;

export const PlaygroundListView = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;

      window.addEventListener("message", (event) => {
        const message = event.data as ExtensionToViewMessage;
        console.log("Received message:", message);

        switch (message.type) {
          case "playgroundsList":
            registry.set(playgroundsAtom, message.data || []);
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

      // Request initial data
      vscode.postMessage({ type: "loadPlaygrounds" });
    }

    const playgrounds = yield* Atom.get(playgroundsAtom);
    const query = yield* Atom.get(searchQueryAtom);

    // Compute filtered playgrounds inline
    const lowerQuery = query.toLowerCase();
    const filteredPlaygrounds = lowerQuery
      ? playgrounds.filter(
          (p) =>
            (p.name && p.name.toLowerCase().includes(lowerQuery)) ||
            (p.description && p.description.toLowerCase().includes(lowerQuery)),
        )
      : playgrounds;

    function handleSearch(e: Event) {
      const target = e.target as HTMLInputElement;
      registry.set(searchQueryAtom, target.value);
    }

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
          {filteredPlaygrounds.length === 0 ? (
            <div class="empty">No playgrounds found</div>
          ) : (
            filteredPlaygrounds.map((playground) => (
              <PlaygroundItem key={playground.hash} playground={playground} />
            ))
          )}
        </div>
      </>
    );
  });
