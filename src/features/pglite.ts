import * as semicolons from "postgres-semicolons";
import type { QueryOptions } from "@electric-sql/pglite";
import { PGliteWorker } from "@electric-sql/pglite/worker";
import { live } from "@electric-sql/pglite/live";

/**
 * PGlite service managing a Web Worker instance with multi-tab support.
 * Only the leader tab will run the actual database instance.
 */
let instanceCounter = 0;

export class PGliteService {
  private db: PGliteWorker | null = null;
  private initPromise: Promise<PGliteWorker> | null = null;
  private worker: Worker | null = null;
  private readonly instanceId = ++instanceCounter;

  /**
   * Initialize the PGlite worker instance.
   * Safe to call multiple times - will return the same instance.
   */
  async initialize(): Promise<PGliteWorker> {
    if (this.db) {
      return this.db;
    }

    // Ensure only one initialization happens at a time
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.createWorker();

    try {
      this.db = await this.initPromise;
      return this.db;
    } finally {
      this.initPromise = null;
    }
  }

  private async createWorker(): Promise<PGliteWorker> {
    try {
      this.worker = new Worker(new URL("./pglite.worker.ts", import.meta.url), {
        type: "module",
      });

      const worker = await PGliteWorker.create(this.worker, {
        extensions: {
          live, // Client-side extension for live queries
        },
      });

      // @ts-expect-error expose for debugging
      window.db = worker;

      // Log leader status
      console.log(
        `[PGlite #${this.instanceId}] PGlite initialized - Leader: ${worker.isLeader}`,
      );

      // Subscribe to leader changes - this can cause the DB connection to close/reopen
      worker.onLeaderChange(() => {
        console.log(
          `[PGlite #${this.instanceId}] Leader changed - Now leader: ${worker.isLeader}`,
        );
        // When leadership changes, the IndexedDB connection may be closed
        // We don't need to do anything here - our retry logic will handle it
      });

      // Run healthcheck
      const healthy = await this.healthcheck(worker);
      if (!healthy) {
        console.warn("PGlite healthcheck failed, but continuing...");
      }

      return worker;
    } catch (error) {
      console.error("Failed to initialize PGlite worker:", error);
      throw new Error(
        `PGlite initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async healthcheck(db: PGliteWorker): Promise<boolean> {
    try {
      const result = await db.query<{ test: 1 }>("select 1 as test");
      return result.rows[0]?.test === 1;
    } catch (error) {
      console.error("PGlite healthcheck failed:", error);
      return false;
    }
  }

  /**
   * Reset the database by closing and reinitializing.
   */
  async reset(): Promise<void> {
    console.log("[PGlite] Resetting database");
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initPromise = null;
    await this.initialize();
  }

  /**
   * Execute a query and return results with statement metadata.
   */
  async query<T>(query: string, params?: unknown[], opts?: QueryOptions) {
    const db = await this.initialize();
    const result = await db.query<T>(query, params, opts);
    return Object.assign(result, { statement: statementFromQuery(query) });
  }

  /**
   * Execute SQL statements and return results with metadata.
   */
  async exec(sql: string, opts?: QueryOptions) {
    const db = await this.initialize();
    const results = db.exec(sql, opts);
    const metadata = metadataFromQueries(sql);
    return (await results).map((r, i) => Object.assign(r, metadata[i]));
  }

  /**
   * Get the underlying PGliteWorker instance.
   * Useful for accessing extensions like live queries.
   */
  async getWorker(): Promise<PGliteWorker> {
    return this.initialize();
  }

  /**
   * Check if this instance is the leader.
   */
  async isLeader(): Promise<boolean> {
    const db = await this.initialize();
    return db.isLeader;
  }

  /**
   * Dispose of the service and close the database connection.
   */
  async dispose(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.initPromise = null;
  }
}

function metadataFromQueries(sql: string) {
  const splits = semicolons.parseSplits(sql, false);
  const queries = semicolons.splitStatements(sql, splits.positions, true);
  return queries.map((query) => {
    const statement = statementFromQuery(query);
    return { query, statement };
  });
}

function statementFromQuery(query: string) {
  const lowerQuery = query.toLowerCase();
  const firstWords = lowerQuery.slice(0, 30).split(/\s+/);
  const statement = lowerQuery.toLowerCase().startsWith("create or replace")
    ? [firstWords[0], firstWords[3]].join(" ")
    : lowerQuery.startsWith("create") ||
        lowerQuery.startsWith("alter") ||
        lowerQuery.startsWith("drop")
      ? firstWords.slice(0, 2).join(" ")
      : (firstWords[0] ?? "");
  return statement.toUpperCase();
}
