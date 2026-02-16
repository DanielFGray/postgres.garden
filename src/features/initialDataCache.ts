import * as S from "effect/Schema";
import { parseRoute } from "../routes";
import { api } from "../api-client";
import { onDidChangeNetworkState } from "./network";

const CACHE_DB_NAME = "pg-garden-initial-data";
const CACHE_STORE_NAME = "initial-data";
const CACHE_KEY = "cached_initial_data";
const INITIAL_DATA_EVENT = "pg-initial-data-updated";

const InitialDataUserSchema = S.Struct({
  id: S.String,
  username: S.String,
  role: S.NullishOr(S.String),
});

const InitialDataRouteParamsSchema = S.Struct({
  playgroundId: S.NullishOr(S.String),
  commitId: S.NullishOr(S.String),
  data: S.NullishOr(S.String),
});

const InitialDataRouteSchema = S.Struct({
  type: S.Literal("home", "playground", "commit", "shared"),
  params: S.NullishOr(InitialDataRouteParamsSchema),
});

const InitialDataCommitSchema = S.Struct({
  id: S.String,
  message: S.String,
  created_at: S.String,
  playground_hash: S.String,
  parent_id: S.NullishOr(S.String),
  files: S.Array(S.Struct({ path: S.String, content: S.String })),
  activeFile: S.NullishOr(S.String),
  timestamp: S.Number,
});

const InitialDataSchema = S.Struct({
  user: S.NullishOr(InitialDataUserSchema),
  route: S.NullishOr(InitialDataRouteSchema),
  commit: S.NullishOr(InitialDataCommitSchema),
});

const CachedInitialDataSchema = S.Struct({
  cachedAt: S.Number,
  value: InitialDataSchema,
});

const MeResponseSchema = S.Struct({
  user: S.NullishOr(InitialDataUserSchema),
});

const isCachedInitialData = S.is(CachedInitialDataSchema);
const isInitialData = S.is(InitialDataSchema);
const isMeResponse = S.is(MeResponseSchema);

type InitialDataUserLike = {
  id: string;
  username: string;
  role?: string | null | undefined;
};

type InitialDataRouteLike = {
  type: "home" | "playground" | "commit" | "shared";
  params?: {
    playgroundId?: string | null | undefined;
    commitId?: string | null | undefined;
    data?: string | null | undefined;
  } | null;
};

type InitialDataCommitLike = {
  id: string;
  message: string;
  created_at: string;
  playground_hash: string;
  parent_id?: string | null | undefined;
  files: ReadonlyArray<{ path: string; content: string }>;
  activeFile?: string | null | undefined;
  timestamp: number;
};
type InitialDataLike = Readonly<{
  user?: InitialDataUserLike | null | undefined;
  route?: InitialDataRouteLike | null | undefined;
  commit?: InitialDataCommitLike | null | undefined;
}>;

function normalizeUser(
  user: InitialDataUserLike | null | undefined,
): InitialDataUser | null {
  if (!user) return null;
  return {
    ...user,
    role: user.role ?? undefined,
  };
}

function normalizeCommit(
  commit: InitialDataCommitLike | null | undefined,
): InitialDataCommit | null {
  if (!commit) return null;
  return {
    ...commit,
    parent_id: commit.parent_id ?? null,
    activeFile: commit.activeFile ?? null,
    files: [...commit.files],
  };
}

function normalizeRoute(
  route: InitialDataRouteLike | null | undefined,
): InitialDataRoute | null {
  if (!route) return null;
  const params = route.params ?? undefined;
  return {
    type: route.type,
    params: params
      ? {
          playgroundId: params.playgroundId ?? undefined,
          commitId: params.commitId ?? undefined,
          data: params.data ?? undefined,
        }
      : undefined,
  };
}

function normalizeInitialData(
  data: InitialDataLike | null | undefined,
): InitialData | null {
  if (!data) return null;
  const user = normalizeUser(data.user) ?? null;
  const route = normalizeRoute(data.route) ?? null;
  const commit = normalizeCommit(data.commit) ?? null;
  return {
    user,
    route,
    commit,
  };
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME);
      }
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open initial data cache"));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readCachedInitialData(): Promise<InitialData | null> {
  if (typeof indexedDB === "undefined") return null;

  try {
    const db = await openCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(CACHE_KEY);
      request.onsuccess = () => {
        const result: unknown = request.result;
        db.close();
        resolve(
          isCachedInitialData(result) ? normalizeInitialData(result.value) : null,
        );
      };
      request.onerror = () => {
        console.warn("[InitialDataCache] Failed to read cache:", request.error);
        db.close();
        resolve(null);
      };
    });
  } catch (err) {
    console.warn("[InitialDataCache] Failed to open cache:", err);
    return null;
  }
}

async function writeCachedInitialData(initialData: InitialData): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  try {
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        console.warn("[InitialDataCache] Failed to write cache:", tx.error);
        db.close();
        resolve();
      };
      const store = tx.objectStore(CACHE_STORE_NAME);
      store.put({ cachedAt: Date.now(), value: initialData }, CACHE_KEY);
    });
  } catch (err) {
    console.warn("[InitialDataCache] Failed to open cache for write:", err);
  }
}

function buildRouteFromUrl(): InitialDataRoute | null {
  const route = parseRoute(window.location.href);
  if (!route) return null;
  return {
    type: route.type,
    params: route.params,
  };
}

function commitMatchesRoute(
  commit: InitialDataCommit,
  route: InitialDataRoute,
): boolean {
  const playgroundId = route.params?.playgroundId;
  if (!playgroundId) return false;

  if (route.type === "playground") {
    return commit.playground_hash === playgroundId;
  }

  if (route.type === "commit") {
    return (
      commit.playground_hash === playgroundId &&
      route.params?.commitId === commit.id
    );
  }

  return false;
}

function selectCommit(
  route: InitialDataRoute | null,
  currentCommit: InitialDataCommit | null | undefined,
  cachedCommit: InitialDataCommit | null | undefined,
): InitialDataCommit | null {
  if (!route || route.type === "home" || route.type === "shared") {
    return null;
  }

  const candidates: InitialDataCommit[] = [];
  if (currentCommit && commitMatchesRoute(currentCommit, route)) {
    candidates.push(currentCommit);
  }
  if (cachedCommit && commitMatchesRoute(cachedCommit, route)) {
    candidates.push(cachedCommit);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  return candidates.reduce((latest, next) =>
    (next.timestamp ?? 0) > (latest.timestamp ?? 0) ? next : latest,
  );
}

function mergeInitialData(
  current: InitialData | null,
  cached: InitialData | null,
  routeFromUrl: InitialDataRoute | null,
): InitialData | null {
  if (!current && !cached) return null;

  const route = routeFromUrl ?? current?.route ?? cached?.route ?? null;
  const user = normalizeUser(current?.user) ?? normalizeUser(cached?.user);
  const commit = selectCommit(
    route,
    normalizeCommit(current?.commit),
    normalizeCommit(cached?.commit),
  );

  return {
    user,
    route,
    commit,
  };
}

function dispatchInitialDataUpdate(user: InitialDataUser | null): void {
  window.dispatchEvent(
    new CustomEvent(INITIAL_DATA_EVENT, { detail: { user } }),
  );
}

async function hydrateInitialData(): Promise<void> {
  const cached = await readCachedInitialData();
  const current = window.__INITIAL_DATA__ ?? null;
  const routeFromUrl = buildRouteFromUrl();
  const merged = mergeInitialData(current, cached, routeFromUrl);

  if (merged && isInitialData(merged)) {
    window.__INITIAL_DATA__ = merged;
  }
}

async function persistInitialDataFromWindow(): Promise<void> {
  const current = normalizeInitialData(window.__INITIAL_DATA__ ?? null);
  if (!current || !isInitialData(current)) return;
  await writeCachedInitialData(current);
}

async function showReauthNeeded(): Promise<void> {
  try {
    if (!window.vscodeReady) return;
    const vscode = await window.vscodeReady;
    void vscode.window.showWarningMessage(
      "Session expired while offline. Please sign in again.",
    );
  } catch (err) {
    console.warn("[InitialDataCache] Failed to show reauth toast:", err);
  }
}

async function revalidateSession(): Promise<void> {
  try {
    const response = await api("/api/me", { credentials: "include" });
    if (response.error) {
      console.warn(
        "[InitialDataCache] Failed to revalidate session:",
        response.error,
      );
      return;
    }

    const meResponse =
      response.data && !("error" in response.data) ? response.data : null;
    const nextUser = normalizeUser(
      isMeResponse(meResponse) ? meResponse.user ?? null : null,
    );
    const prevUser = window.__INITIAL_DATA__?.user ?? null;

    const current = window.__INITIAL_DATA__ ?? {
      user: null,
      route: null,
      commit: null,
    };

    window.__INITIAL_DATA__ = {
      ...current,
      user: nextUser,
    };

    await writeCachedInitialData(window.__INITIAL_DATA__);
    dispatchInitialDataUpdate(nextUser);

    if (prevUser && !nextUser) {
      await showReauthNeeded();
    }
  } catch (err) {
    console.warn("[InitialDataCache] Session revalidation failed:", err);
  }
}

await hydrateInitialData();
void persistInitialDataFromWindow();

onDidChangeNetworkState((state) => {
  if (state === "online") {
    void revalidateSession();
  }
});
