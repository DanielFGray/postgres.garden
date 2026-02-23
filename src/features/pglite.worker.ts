import { PGlite } from "@electric-sql/pglite";
import { worker } from "@electric-sql/pglite/worker";
import { vector } from "@electric-sql/pglite/vector";
import { pg_ivm } from "@electric-sql/pglite/pg_ivm";
import { pg_uuidv7 } from "@electric-sql/pglite/pg_uuidv7";
import { pgtap } from "@electric-sql/pglite/pgtap";

// Import contrib extensions
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { auto_explain } from "@electric-sql/pglite/contrib/auto_explain";
import { bloom } from "@electric-sql/pglite/contrib/bloom";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { cube } from "@electric-sql/pglite/contrib/cube";
import { earthdistance } from "@electric-sql/pglite/contrib/earthdistance";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { isn } from "@electric-sql/pglite/contrib/isn";
import { lo } from "@electric-sql/pglite/contrib/lo";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { seg } from "@electric-sql/pglite/contrib/seg";
import { tablefunc } from "@electric-sql/pglite/contrib/tablefunc";
import { tcn } from "@electric-sql/pglite/contrib/tcn";
import { tsm_system_rows } from "@electric-sql/pglite/contrib/tsm_system_rows";
import { tsm_system_time } from "@electric-sql/pglite/contrib/tsm_system_time";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

// ---------------------------------------------------------------------------
// Workspace FS sync — bridge between VSCode FS and PGlite's Emscripten FS
// Uses a dedicated MessagePort so it doesn't interfere with PGliteWorker's
// own message handling on the global `self`.
// ---------------------------------------------------------------------------

let pgInstance: PGlite | null = null;

function ensureParentDirs(FS: EmscriptenFS, path: string) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    try {
      FS.mkdir(current);
    } catch {
      // already exists
    }
  }
}

/** Recursively collect all file paths under `dir` */
function listRecursive(FS: EmscriptenFS, dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = (FS.readdir(dir) as string[]).filter((e: string) => e !== "." && e !== "..");
  } catch {
    return results;
  }
  for (const name of entries) {
    const full = `${dir}/${name}`;
    try {
      const stat = FS.stat(full);
      if (FS.isDir(stat.mode)) {
        results.push(...listRecursive(FS, full));
      } else {
        results.push(full);
      }
    } catch {
      // skip inaccessible entries
    }
  }
  return results;
}

interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  unlink(path: string): void;
  isDir(mode: number): boolean;
}

function setupFsPort(port: MessagePort) {
  port.onmessage = (msg: MessageEvent) => {
    const { id, type } = msg.data as { id: number; type: string; path?: string; content?: ArrayBuffer };

    if (!pgInstance) {
      port.postMessage({ id, ok: false, error: "PGlite not initialized" });
      return;
    }

    // oxlint-disable-next-line typescript/no-explicit-any -- Module.FS is not in public types
    const FS = (pgInstance as any).Module.FS as EmscriptenFS;

    switch (type) {
      case "writeFile": {
        const { path, content } = msg.data as { path: string; content: ArrayBuffer; id: number; type: string };
        try {
          ensureParentDirs(FS, path);
          FS.writeFile(path, new Uint8Array(content));
          port.postMessage({ id, ok: true });
        } catch (err: unknown) {
          port.postMessage({ id, ok: false, error: String(err) });
        }
        break;
      }

      case "readFile": {
        const { path } = msg.data as { path: string; id: number; type: string };
        try {
          const data = FS.readFile(path);
          const copy = data.slice();
          port.postMessage({ id, ok: true, content: copy.buffer }, [copy.buffer]);
        } catch {
          port.postMessage({ id, ok: false, error: "File not found" });
        }
        break;
      }

      case "listDir": {
        const { path } = msg.data as { path: string; id: number; type: string };
        const files = listRecursive(FS, path);
        port.postMessage({ id, ok: true, files });
        break;
      }

      case "deleteFile": {
        const { path } = msg.data as { path: string; id: number; type: string };
        try {
          FS.unlink(path);
          port.postMessage({ id, ok: true });
        } catch {
          port.postMessage({ id, ok: false, error: "File not found" });
        }
        break;
      }

      default:
        port.postMessage({ id, ok: false, error: `Unknown FS operation: ${type}` });
    }
  };
}

// Receive the FS sync port BEFORE worker() takes over self.onmessage.
// addEventListener doesn't conflict with worker()'s own message setup.
self.addEventListener("message", (e: MessageEvent) => {
  if ((e.data as { type?: string })?.type === "pg-fs-port") {
    setupFsPort((e.data as { port: MessagePort }).port);
  }
});

void worker({
  async init(options) {
    const db = await PGlite.create({
      dataDir: options.dataDir,
      extensions: {
        vector,
        pg_ivm,
        pg_uuidv7,
        pgtap,
        amcheck,
        auto_explain,
        bloom,
        btree_gin,
        btree_gist,
        citext,
        cube,
        earthdistance,
        fuzzystrmatch,
        hstore,
        isn,
        lo,
        ltree,
        pg_trgm,
        seg,
        tablefunc,
        tcn,
        tsm_system_rows,
        tsm_system_time,
        uuid_ossp,
      },
    });

    // Store for FS sync access and create /workspace mount point
    pgInstance = db;
    try {
      // oxlint-disable-next-line typescript/no-explicit-any -- Module.FS not in public types
      (db as any).Module.FS.mkdir("/workspace");
    } catch {
      // already exists (e.g. after reinitialize)
    }

    return db;
  },
});
