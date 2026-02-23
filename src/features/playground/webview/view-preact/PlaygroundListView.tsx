import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest, sendCommand } from "../api";

interface PlaygroundListItem {
  hash: string;
  name: string | null;
  description?: string | null;
  fork_hash?: string | null;
  stars: string;
  created_at: string;
  updated_at: string;
  user?: { username: string };
}

interface CreatePlaygroundResult {
  playground_hash: string;
}

import { parseSearchHint } from "lib/searchDSL.js";

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const searchInputAtom = Atom.make("");
const mutationErrorAtom = Atom.make<string | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let currentSearchQuery = "";

function buildSearchUrl(q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const qs = params.toString();
  return `/api/playgrounds/search${qs ? `?${qs}` : ""}`;
}

const playgroundsAtom = Atom.make(
  Effect.suspend(() =>
    apiRequest<PlaygroundListItem[]>(buildSearchUrl(currentSearchQuery), "GET", undefined, {
      action: "playground.list.search",
    }),
  ),
);

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

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

function PlaygroundItem(props: {
  playground: PlaygroundListItem;
  registry: AtomRegistry.Registry;
}) {
  const { playground, registry } = props;

  function handleOpen() {
    sendCommand("openPlayground", { hash: playground.hash });
  }

  function handleFork(e: Event) {
    e.stopPropagation();
    registry.set(mutationErrorAtom, null);
    void Effect.runFork(
      apiRequest("/api/playgrounds/" + playground.hash + "/fork", "POST", { name: null }, {
        action: "playground.list.fork",
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registry.refresh(playgroundsAtom);
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            registry.set(mutationErrorAtom, err.message);
          }),
        ),
      ),
    );
  }

  function handleDelete(e: Event) {
    e.stopPropagation();
    if (!confirm("Delete this playground?")) return;

    registry.set(mutationErrorAtom, null);
    void Effect.runFork(
      apiRequest("/api/playgrounds/" + playground.hash, "DELETE", undefined, {
        action: "playground.list.delete",
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registry.refresh(playgroundsAtom);
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            registry.set(mutationErrorAtom, err.message);
          }),
        ),
      ),
    );
  }

  function handleToggleStar(e: Event) {
    e.stopPropagation();
    void Effect.runFork(
      apiRequest("/api/playgrounds/" + playground.hash + "/star", "POST", undefined, {
        action: "playground.list.toggle_star",
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            registry.refresh(playgroundsAtom);
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            registry.set(mutationErrorAtom, err.message);
          }),
        ),
      ),
    );
  }

  return (
    <div class="playground-item" onClick={handleOpen}>
      <div class="playground-header">
        <span class="playground-name">{playground.name || "Untitled"}</span>
        {playground.user?.username && (
          <span class="playground-owner">{playground.user.username}</span>
        )}
      </div>

      {playground.description && <div class="playground-description">{playground.description}</div>}

      <div class="playground-footer">
        <span class="playground-date">{formatDate(playground.created_at)}</span>
        <div class="playground-actions">
          <button
            class="icon-button action-star"
            title="Star"
            onClick={handleToggleStar}
          >
            <i class="codicon codicon-star-empty"></i>
            {Number(playground.stars ?? "0") > 0 && (
              <span class="star-count">{playground.stars}</span>
            )}
          </button>
          <button
            class="icon-button action-open"
            title="Open"
            onClick={handleOpen}
          >
            <i class="codicon codicon-go-to-file"></i>
          </button>
          <button
            class="icon-button action-fork"
            title="Fork"
            onClick={handleFork}
          >
            <i class="codicon codicon-repo-forked"></i>
          </button>
          <button
            class="icon-button action-delete"
            title="Delete"
            onClick={handleDelete}
          >
            <i class="codicon codicon-trash"></i>
          </button>
        </div>
      </div>
    </div>
  );
}

export const PlaygroundListView = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(playgroundsAtom);
    const searchInput = yield* Atom.get(searchInputAtom);
    const mutationError = yield* Atom.get(mutationErrorAtom);

    const hint = parseSearchHint(searchInput);

    function handleCreate() {
      const name = prompt("Playground name:");
      if (!name) return;

      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest<CreatePlaygroundResult>("/api/playgrounds", "POST", {
          name,
          message: "Initial commit",
          files: [],
        }, {
          action: "playground.list.create",
        }).pipe(
          Effect.tap((resp) =>
            Effect.sync(() => {
              sendCommand("openPlayground", { hash: resp.playground_hash });
              registry.refresh(playgroundsAtom);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
        ),
      );
    }

    function handleSearch(e: Event) {
      const target = e.target as HTMLInputElement;
      const value = target.value;
      registry.set(searchInputAtom, value);

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentSearchQuery = value;
        registry.refresh(playgroundsAtom);
      }, 300);
    }

    return Result.builder(result)
      .onInitial(() => (
        <div class="playground-list-loading">
          <p>Loading playgrounds...</p>
        </div>
      ))
      .onError((error) => (
        <div class="playground-list-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(playgroundsAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess((playgrounds) => (
        <>
          {mutationError && (
            <div class="auth-error" style={{ margin: "0 0 8px" }}>
              <i class="codicon codicon-error" />
              <span>{mutationError}</span>
            </div>
          )}

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
              placeholder="Search... is:starred by:user sort:created|updated|stars"
              value={searchInput}
              onInput={handleSearch}
            />
            {hint.hasFilters && (
              <div class="search-hint">
                Showing {hint.starred ? "starred" : ""}{hint.username ? `${hint.starred ? " " : ""}by ${hint.username}` : hint.starred ? "" : "all"}
                {hint.sortLabel ? ` \u00b7 sorted by ${hint.sortLabel}` : ""}
              </div>
            )}
          </div>

          <div class="playground-list">
            {playgrounds.length === 0 ? (
              <div class="empty">No playgrounds found</div>
            ) : (
              playgrounds.map((playground) => (
                <PlaygroundItem
                  key={playground.hash}
                  playground={playground}
                  registry={registry}
                />
              ))
            )}
          </div>
        </>
      ))
      .render();
  });
