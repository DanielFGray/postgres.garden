import { DateTime, Effect, Match, Option } from "effect";
import * as S from "effect/Schema";
import { createSignal, onCleanup, Show } from "solid-js";
import { runAction } from "../api";
import { announceInitialized, apiCall, openPlayground } from "./api";

/** What the extension host tells this panel to show. */
const HostMessage = S.Union([
  S.Struct({
    type: S.Literal("setPlaygroundId"),
    data: S.Struct({ playgroundId: S.String }),
  }),
  S.Struct({ type: S.Literal("clearPlayground") }),
  S.Struct({ type: S.Literal("triggerSave") }),
]);

const fetchPlayground = (hash: string) =>
  apiCall("playground.panel.load", (api) =>
    api.apiPlaygrounds.playgroundByHash({ params: { hash } }),
  );

type PlaygroundDetail = Effect.Success<ReturnType<typeof fetchPlayground>>;
type EditableField = "name" | "description" | "privacy";

const [playground, setPlayground] = createSignal<Option.Option<PlaygroundDetail>>(Option.none());
const [isDirty, setIsDirty] = createSignal(false);
const [saveStatus, setSaveStatus] = createSignal({ message: "", type: "" });
const [starInfo, setStarInfo] = createSignal<{
  starred: boolean;
  count: number;
}>({
  starred: false,
  count: 0,
});

const showSaveStatus = (message: string, type: string) =>
  Effect.gen(function* () {
    setSaveStatus({ message, type });
    if (type === "success") {
      yield* Effect.sleep(3000);
      setSaveStatus({ message: "", type: "" });
    }
  });

/** Runs `run` on the loaded playground; does nothing when none is loaded. */
const withPlayground = <A, E>(run: (pg: PlaygroundDetail) => Effect.Effect<A, E>) =>
  Option.match(playground(), { onNone: () => Effect.void, onSome: run });

const doSave = () =>
  isDirty()
    ? withPlayground((pg) =>
        Effect.gen(function* () {
          setSaveStatus({ message: "Saving...", type: "info" });
          const updated = yield* apiCall("playground.panel.save", (api) =>
            api.apiPlaygrounds.updatePlayground({
              params: { hash: pg.hash },
              payload: {
                name: pg.name,
                description: pg.description,
                privacy: pg.privacy,
              },
            }),
          );
          // The update answers with the bare row; stars, owner and fork origin
          // are unchanged by a metadata save, so they stay from the load.
          setPlayground(Option.some({ ...pg, ...updated }));
          setIsDirty(false);
          yield* showSaveStatus("Saved", "success");
        }).pipe(Effect.catch((error) => showSaveStatus(error.message || "Save failed", "error"))),
      )
    : Effect.void;

const loadPlayground = (hash: string) =>
  fetchPlayground(hash).pipe(
    Effect.tap((data) =>
      Effect.sync(() => {
        setPlayground(Option.some(data));
        setIsDirty(false);
        setStarInfo({ starred: data.is_starred, count: Number(data.stars) });
      }),
    ),
    Effect.catch((error) =>
      Effect.logError("Failed to load playground:", error).pipe(
        Effect.andThen(showSaveStatus("Failed to load", "error")),
      ),
    ),
  );

function handleMetadataChange<F extends EditableField>(field: F, value: PlaygroundDetail[F]) {
  Option.map(playground(), (current) => {
    setPlayground(Option.some({ ...current, [field]: value }));
    setIsDirty(true);
  });
}

const toggleStar = () =>
  withPlayground((pg) => {
    const current = starInfo();
    // Optimistic update
    setStarInfo({
      starred: !current.starred,
      count: current.starred ? current.count - 1 : current.count + 1,
    });
    return apiCall("playground.panel.toggle_star", (api) =>
      api.apiPlaygrounds.togglePlaygroundStar({ params: { hash: pg.hash } }),
    ).pipe(
      // Reconcile with server
      Effect.tap((result) =>
        Effect.sync(() => setStarInfo((info) => ({ ...info, starred: result.starred }))),
      ),
      // Revert optimistic update
      Effect.catch(() => Effect.sync(() => setStarInfo(current))),
    );
  });

const fork = () =>
  withPlayground((pg) =>
    apiCall("playground.panel.fork", (api) =>
      api.apiPlaygrounds.forkPlayground({
        params: { hash: pg.hash },
        payload: {},
      }),
    ).pipe(
      Effect.flatMap((forked) => openPlayground(forked.playground_hash)),
      Effect.catch((error) => showSaveStatus(error.message || "Fork failed", "error")),
    ),
  );

const decodePrivacy = S.decodeUnknownOption(S.Literals(["private", "secret", "public"]));

export const PlaygroundEditorPanel = () => {
  const handleHostMessage = (event: MessageEvent) => {
    Option.map(S.decodeUnknownOption(HostMessage)(event.data), (message) =>
      Match.value(message).pipe(
        Match.discriminator("type")("setPlaygroundId", (m) =>
          runAction(loadPlayground(m.data.playgroundId)),
        ),
        Match.discriminator("type")("clearPlayground", () => {
          setPlayground(Option.none());
          setIsDirty(false);
          setStarInfo({ starred: false, count: 0 });
        }),
        Match.discriminator("type")("triggerSave", () => runAction(doSave())),
        Match.exhaustive,
      ),
    );
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      runAction(doSave());
    }
  };

  window.addEventListener("message", handleHostMessage);
  document.addEventListener("keydown", handleKeydown);
  onCleanup(() => {
    window.removeEventListener("message", handleHostMessage);
    document.removeEventListener("keydown", handleKeydown);
  });

  runAction(announceInitialized);

  return (
    <Show
      when={Option.getOrUndefined(playground())}
      fallback={<div class="loading">No playground loaded</div>}
    >
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
                onChange={(e) =>
                  Option.map(decodePrivacy(e.currentTarget.value), (privacy) =>
                    handleMetadataChange("privacy", privacy),
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
                value={pg().description || ""}
                onInput={(e) => handleMetadataChange("description", e.currentTarget.value)}
              />
            </div>

            <div class="action-row">
              <button
                class={`action-pill ${starInfo().starred ? "action-pill--starred" : ""}`}
                title={starInfo().starred ? "Unstar" : "Star"}
                onClick={() => runAction(toggleStar())}
              >
                <i
                  class={`codicon ${starInfo().starred ? "codicon-star-full" : "codicon-star-empty"}`}
                />
                <span class="action-pill__label">{starInfo().starred ? "Starred" : "Star"}</span>
                <Show when={starInfo().count > 0}>
                  <span class="action-pill__count">{starInfo().count}</span>
                </Show>
              </button>

              <button
                class="action-pill"
                title="Fork this playground"
                onClick={() => runAction(fork())}
              >
                <i class="codicon codicon-repo-forked" />
                <span class="action-pill__label">Fork</span>
              </button>
            </div>

            <div class="form-group">
              <span class="meta-text">
                Created {DateTime.toDate(pg().created_at).toLocaleDateString()}
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
