import { createSignal, onCleanup, refresh, Errored, For, Loading, Show } from "solid-js";
import { apiRequest, sendCommand } from "../api";
import { createRequest, runRequest } from "../../../webview/request";
import { parseSearchHint } from "lib/searchDSL.js";
import { DateTime, Effect, Fiber } from "effect";

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

function buildSearchUrl(q: string): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  const qs = params.toString();
  return `/api/playgrounds/search${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function formatDate(dateString: string) {
  const date = DateTime.toDate(DateTime.makeUnsafe(dateString));
  const now = DateTime.toDate(DateTime.nowUnsafe());
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString();
}

function PlaygroundItem(props: {
  playground: PlaygroundListItem;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const mutate = (request: ReturnType<typeof apiRequest>) => {
    void runRequest(request).then(props.onChanged, (error: Error) => props.onError(error.message));
  };

  function handleOpen() {
    sendCommand("openPlayground", { hash: props.playground.hash });
  }

  function handleFork(e: Event) {
    e.stopPropagation();
    props.onError("");
    mutate(
      apiRequest(
        "/api/playgrounds/" + props.playground.hash + "/fork",
        "POST",
        { name: null },
        { action: "playground.list.fork" },
      ),
    );
  }

  function handleDelete(e: Event) {
    e.stopPropagation();
    if (!confirm("Delete this playground?")) return;

    props.onError("");
    mutate(
      apiRequest("/api/playgrounds/" + props.playground.hash, "DELETE", undefined, {
        action: "playground.list.delete",
      }),
    );
  }

  function handleToggleStar(e: Event) {
    e.stopPropagation();
    mutate(
      apiRequest("/api/playgrounds/" + props.playground.hash + "/star", "POST", undefined, {
        action: "playground.list.toggle_star",
      }),
    );
  }

  return (
    <div class="playground-item" onClick={handleOpen}>
      <div class="playground-header">
        <span class="playground-name">{props.playground.name || "Untitled"}</span>
        <Show when={props.playground.user?.username}>
          {(username) => <span class="playground-owner">{username()}</span>}
        </Show>
      </div>

      <Show when={props.playground.description}>
        {(description) => <div class="playground-description">{description()}</div>}
      </Show>

      <div class="playground-footer">
        <span class="playground-date">{formatDate(props.playground.created_at)}</span>
        <div class="playground-actions">
          <button class="icon-button action-star" title="Star" onClick={handleToggleStar}>
            <i class="codicon codicon-star-empty" />
            <Show when={Number(props.playground.stars ?? "0") > 0}>
              <span class="star-count">{props.playground.stars}</span>
            </Show>
          </button>
          <button class="icon-button action-open" title="Open" onClick={handleOpen}>
            <i class="codicon codicon-go-to-file" />
          </button>
          <button class="icon-button action-fork" title="Fork" onClick={handleFork}>
            <i class="codicon codicon-repo-forked" />
          </button>
          <button class="icon-button action-delete" title="Delete" onClick={handleDelete}>
            <i class="codicon codicon-trash" />
          </button>
        </div>
      </div>
    </div>
  );
}

export const PlaygroundListView = () => {
  const [searchInput, setSearchInput] = createSignal("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  let debounceFiber: Fiber.Fiber<void, never> | undefined;

  // Tracks `searchQuery`, so committing a debounced search re-runs the request
  // on its own — no explicit refetch needed.
  const playgrounds = createRequest(() =>
    apiRequest<PlaygroundListItem[]>(buildSearchUrl(searchQuery()), "GET", undefined, {
      action: "playground.list.search",
    }),
  );

  const hint = () => parseSearchHint(searchInput());

  onCleanup(() => debounceFiber && Effect.runFork(Fiber.interrupt(debounceFiber)));

  function handleCreate() {
    const name = prompt("Playground name:");
    if (!name) return;

    setMutationError(null);
    void runRequest(
      apiRequest<CreatePlaygroundResult>(
        "/api/playgrounds",
        "POST",
        { name, message: "Initial commit", files: [] },
        { action: "playground.list.create" },
      ),
    ).then(
      (resp) => {
        sendCommand("openPlayground", { hash: resp.playground_hash });
        refresh(playgrounds);
      },
      (error: Error) => setMutationError(error.message),
    );
  }

  function handleSearch(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    setSearchInput(value);

    if (debounceFiber) Effect.runFork(Fiber.interrupt(debounceFiber));
    debounceFiber = Effect.runFork(
      Effect.sleep(300).pipe(Effect.tap(() => Effect.sync(() => setSearchQuery(value)))),
    );
  }

  return (
    <>
      <Show when={mutationError()}>
        {(message) => (
          <div class="auth-error" style={{ margin: "0 0 8px" }}>
            <i class="codicon codicon-error" />
            <span>{message()}</span>
          </div>
        )}
      </Show>

      <div class="header">
        <h3>Playgrounds</h3>
        <button
          class="icon-button"
          id="create-btn"
          title="Create Playground"
          onClick={handleCreate}
        >
          <i class="codicon codicon-add" />
        </button>
      </div>

      <div class="search-container">
        <input
          type="text"
          id="search"
          placeholder="Search... is:starred by:user sort:created|updated|stars"
          value={searchInput()}
          onInput={handleSearch}
        />
        <Show when={hint().hasFilters}>
          <div class="search-hint">
            Showing {hint().starred ? "starred" : ""}
            {hint().username
              ? `${hint().starred ? " " : ""}by ${hint().username}`
              : hint().starred
                ? ""
                : "all"}
            {hint().sortLabel ? ` · sorted by ${hint().sortLabel}` : ""}
          </div>
        </Show>
      </div>

      <Errored
        fallback={(error, reset) => (
          <div class="playground-list-error">
            <i class="codicon codicon-error" />
            <span>{String(error())}</span>
            <button
              class="button"
              onClick={() => {
                refresh(playgrounds);
                reset();
              }}
            >
              Retry
            </button>
          </div>
        )}
      >
        <Loading
          fallback={
            <div class="playground-list-loading">
              <p>Loading playgrounds...</p>
            </div>
          }
        >
          <div class="playground-list">
            <Show
              when={playgrounds().length > 0}
              fallback={<div class="empty">No playgrounds found</div>}
            >
              <For each={playgrounds()}>
                {(playground) => (
                  <PlaygroundItem
                    playground={playground}
                    onChanged={() => refresh(playgrounds)}
                    onError={(message) => setMutationError(message || null)}
                  />
                )}
              </For>
            </Show>
          </div>
        </Loading>
      </Errored>
    </>
  );
};
