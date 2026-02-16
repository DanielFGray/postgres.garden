import type { Privacy } from "./types";

export type LocalPlaygroundSyncStatus =
  | "local_only"
  | "synced"
  | "modified"
  | "conflict";

export type LocalCommitSyncStatus = "local_only" | "synced";

export interface LocalPlayground {
  hash: string;
  name: string | null;
  description: string | null;
  privacy: Privacy;
  files: Array<{ path: string; content: string }>;
  created_at: string;
  updated_at: string;
  sync_status: LocalPlaygroundSyncStatus;
  server_hash: string | null;
}

export interface LocalCommit {
  id: string;
  playground_hash: string;
  parent_id: string | null;
  files: Array<{ path: string; content: string }>;
  message: string;
  created_at: string;
  activeFile: string | null;
  timestamp: number;
  sync_status: LocalCommitSyncStatus;
}

const DB_NAME = "pg-garden-playgrounds";
const DB_VERSION = 1;
const PLAYGROUND_STORE = "local_playgrounds";
const COMMIT_STORE = "local_commits";
const PLAYGROUND_SERVER_HASH_INDEX = "server_hash";
const COMMIT_PLAYGROUND_INDEX = "playground_hash";

let dbPromise: Promise<IDBDatabase> | null = null;

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PLAYGROUND_STORE)) {
        const store = db.createObjectStore(PLAYGROUND_STORE, { keyPath: "hash" });
        store.createIndex(PLAYGROUND_SERVER_HASH_INDEX, "server_hash", {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains(COMMIT_STORE)) {
        const store = db.createObjectStore(COMMIT_STORE, { keyPath: "id" });
        store.createIndex(COMMIT_PLAYGROUND_INDEX, "playground_hash", {
          unique: false,
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });

  return dbPromise;
};

export async function saveLocalPlayground(
  playground: LocalPlayground,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PLAYGROUND_STORE, "readwrite");
  tx.objectStore(PLAYGROUND_STORE).put(playground);
  await transactionDone(tx);
}

export async function saveLocalCommit(commit: LocalCommit): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(COMMIT_STORE, "readwrite");
  tx.objectStore(COMMIT_STORE).put(commit);
  await transactionDone(tx);
}

export async function deleteLocalCommit(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(COMMIT_STORE, "readwrite");
  tx.objectStore(COMMIT_STORE).delete(id);
  await transactionDone(tx);
}

export async function deleteLocalPlayground(hash: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PLAYGROUND_STORE, "readwrite");
  tx.objectStore(PLAYGROUND_STORE).delete(hash);
  await transactionDone(tx);
}

export async function getLocalPlayground(
  hash: string,
): Promise<LocalPlayground | null> {
  const db = await openDb();
  const tx = db.transaction(PLAYGROUND_STORE, "readonly");
  const result = await requestToPromise<LocalPlayground | undefined>(
    tx
      .objectStore(PLAYGROUND_STORE)
      .get(hash) as IDBRequest<LocalPlayground | undefined>,
  );
  await transactionDone(tx);
  return result ?? null;
}

export async function getLocalPlaygroundByServerHash(
  serverHash: string,
): Promise<LocalPlayground | null> {
  const db = await openDb();
  const tx = db.transaction(PLAYGROUND_STORE, "readonly");
  const store = tx.objectStore(PLAYGROUND_STORE);
  const index = store.index(PLAYGROUND_SERVER_HASH_INDEX);
  const result = await requestToPromise<LocalPlayground | undefined>(
    index.get(serverHash) as IDBRequest<LocalPlayground | undefined>,
  );
  await transactionDone(tx);
  return result ?? null;
}

export async function getLocalCommit(id: string): Promise<LocalCommit | null> {
  const db = await openDb();
  const tx = db.transaction(COMMIT_STORE, "readonly");
  const result = await requestToPromise<LocalCommit | undefined>(
    tx.objectStore(COMMIT_STORE).get(id) as IDBRequest<LocalCommit | undefined>,
  );
  await transactionDone(tx);
  return result ?? null;
}

export async function listLocalCommits(
  playgroundHash: string,
): Promise<LocalCommit[]> {
  const db = await openDb();
  const tx = db.transaction(COMMIT_STORE, "readonly");
  const store = tx.objectStore(COMMIT_STORE);
  const index = store.index(COMMIT_PLAYGROUND_INDEX);
  const commits = await requestToPromise<LocalCommit[]>(
    index.getAll(playgroundHash) as IDBRequest<LocalCommit[]>,
  );
  await transactionDone(tx);
  return commits ?? [];
}

export async function getLatestLocalCommit(
  playgroundHash: string,
): Promise<LocalCommit | null> {
  const commits = await listLocalCommits(playgroundHash);
  if (commits.length === 0) return null;

  const first = commits[0]!;
  return commits.slice(1).reduce(
    (latest, commit) => (commit.timestamp > latest.timestamp ? commit : latest),
    first,
  );
}

export async function updateLocalPlayground(
  hash: string,
  update: Partial<LocalPlayground>,
): Promise<LocalPlayground | null> {
  const current = await getLocalPlayground(hash);
  if (!current) return null;
  const next = { ...current, ...update };
  await saveLocalPlayground(next);
  return next;
}

export async function markLocalCommitSynced(id: string): Promise<void> {
  const commit = await getLocalCommit(id);
  if (!commit || commit.sync_status === "synced") return;
  await saveLocalCommit({ ...commit, sync_status: "synced" });
}
