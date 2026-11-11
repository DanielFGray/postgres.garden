import { createSignal, onCleanup, refresh, Errored, For, Loading, Show } from "solid-js";
import { runAction } from "../api";
import { apiCall, openPlayground } from "./api";
import { createRequest } from "../../../webview/request";
import { parseSearchHint } from "lib/searchDSL.js";
import { DateTime, Duration, Effect, Fiber } from "effect";

const searchPlaygrounds = (q: string) =>
  apiCall("playground.list.search", (api) =>
    // An empty search means "no filter", which the contract spells as no `q`.
    api.apiPlaygrounds.searchPlaygrounds({
      query: { q: q === "" ? undefined : q },
    }),
  );

type PlaygroundListItem = Effect.Success<ReturnType<typeof searchPlaygrounds>>[number];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function formatDate(date: Date) {
  const diffDays = Math.floor(
    Duration.toDays(DateTime.distance(DateTime.fromDateUnsafe(date), DateTime.nowUnsafe())),
  );

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
  const mutate = <A, E extends Error>(request: Effect.Effect<A, E>) =>
    runAction(
      Effect.match(request, {
        onSuccess: props.onChanged,
        onFailure: (error) => props.onError(error.message),
      }),
    );
  const hash = props.playground.hash;

  function handleOpen() {
    runAction(openPlayground(hash));
  }

  function handleFork(e: Event) {
    e.stopPropagation();
    props.onError("");
    mutate(
      apiCall("playground.list.fork", (api) =>
        api.apiPlaygrounds.forkPlayground({
          params: { hash },
          payload: { name: null },
        }),
      ).pipe(Effect.flatMap((forked) => openPlayground(forked.playground_hash))),
    );
  }

  function handleDelete(e: Event) {
    e.stopPropagation();
    if (!confirm("Delete this playground?")) return;

    props.onError("");
    mutate(
      apiCall("playground.list.delete", (api) =>
        api.apiPlaygrounds.deletePlayground({ params: { hash } }),
      ),
    );
  }

  function handleToggleStar(e: Event) {
    e.stopPropagation();
    mutate(
      apiCall("playground.list.toggle_star", (api) =>
        api.apiPlaygrounds.togglePlaygroundStar({ params: { hash } }),
      ),
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
            <Show when={props.playground.stars > 0n}>
              <span class="star-count">{String(props.playground.stars)}</span>
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
  const playgrounds = createRequest(() => searchPlaygrounds(searchQuery()));

  const hint = () => parseSearchHint(searchInput());

  onCleanup(() => debounceFiber && Effect.runFork(Fiber.interrupt(debounceFiber)));

  function handleSearch(value: string) {
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
      </div>

      <div class="search-container">
        <input
          type="text"
          id="search"
          placeholder="Search... is:starred by:user sort:created|updated|stars"
          value={searchInput()}
          onInput={(e) => handleSearch(e.currentTarget.value)}
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
                void refresh(playgrounds);
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
