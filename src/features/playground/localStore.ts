import * as S from "effect/Schema";

const CACHE_DB_NAME = "pg-garden-playground-cache";
const CACHE_STORE_NAME = "playground-commits";

const CommitSchema = S.Struct({
  id: S.String,
  message: S.String,
  created_at: S.String,
  playground_hash: S.String,
  parent_id: S.NullishOr(S.String),
  files: S.Array(S.Struct({ path: S.String, content: S.String })),
  activeFile: S.NullishOr(S.String),
  timestamp: S.Number,
});

const CachedCommitSchema = S.Struct({
  key: S.String,
  playgroundHash: S.String,
  commitId: S.String,
  cachedAt: S.Number,
  commit: CommitSchema,
});

const isCachedCommit = S.is(CachedCommitSchema);

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open playground cache"));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function buildCommitKey(commitId: string): string {
  return `commit:${commitId}`;
}

function buildLatestKey(playgroundHash: string): string {
  return `playground:${playgroundHash}:latest`;
}

async function readCachedCommit(key: string): Promise<InitialDataCommit | null> {
  if (typeof indexedDB === "undefined") return null;

  try {
    const db = await openCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const result: unknown = request.result;
        db.close();
        if (!isCachedCommit(result)) {
          resolve(null);
          return;
        }
        resolve({
          ...result.commit,
          parent_id: result.commit.parent_id ?? null,
          activeFile: result.commit.activeFile ?? null,
          files: [...result.commit.files],
        });
      };
      request.onerror = () => {
        console.warn("[PlaygroundCache] Failed to read cache:", request.error);
        db.close();
        resolve(null);
      };
    });
  } catch (err) {
    console.warn("[PlaygroundCache] Failed to open cache:", err);
    return null;
  }
}

async function writeCachedCommit(
  key: string,
  playgroundHash: string,
  commit: InitialDataCommit,
): Promise<void> {
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
        console.warn("[PlaygroundCache] Failed to write cache:", tx.error);
        db.close();
        resolve();
      };
      const store = tx.objectStore(CACHE_STORE_NAME);
      store.put({
        key,
        playgroundHash,
        commitId: commit.id,
        cachedAt: Date.now(),
        commit,
      });
    });
  } catch (err) {
    console.warn("[PlaygroundCache] Failed to open cache for write:", err);
  }
}

export async function cachePlaygroundCommit(options: {
  playgroundHash: string;
  commit: InitialDataCommit;
  isLatest: boolean;
}): Promise<void> {
  const { playgroundHash, commit, isLatest } = options;

  await writeCachedCommit(buildCommitKey(commit.id), playgroundHash, commit);
  if (isLatest) {
    await writeCachedCommit(buildLatestKey(playgroundHash), playgroundHash, commit);
  }
}

export async function getCachedPlaygroundCommit(options: {
  playgroundHash: string;
  commitId?: string;
}): Promise<InitialDataCommit | null> {
  const { playgroundHash, commitId } = options;

  if (commitId) {
    return await readCachedCommit(buildCommitKey(commitId));
  }

  return await readCachedCommit(buildLatestKey(playgroundHash));
}
