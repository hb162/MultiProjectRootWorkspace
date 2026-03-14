/**
 * SQLite abstraction that prefers the built-in `node:sqlite` module
 * (available in Node.js 22.5+, no native binary → no ABI issues) and falls
 * back to `better-sqlite3` on older runtimes (e.g. system Node.js 20).
 *
 * The public interface intentionally mirrors the better-sqlite3 API so that
 * GraphStore requires minimal changes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DbRow = Record<string, unknown>;

export interface Statement {
  /** Execute the statement. Accepts named-param object or positional spread. */
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** Return all matching rows as plain objects. */
  all(...args: unknown[]): DbRow[];
  /** Return the first matching row, or undefined. */
  get(...args: unknown[]): DbRow | undefined;
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Wrap a function in a BEGIN / COMMIT transaction (rolls back on error). */
  transaction<T>(fn: (arg: T) => void): (arg: T) => void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function openDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Prefer node:sqlite (Node 22.5+) — zero native binaries, works in any ABI.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeSqlite = require("node:sqlite") as {
      DatabaseSync: new (path: string) => NodeSqliteDb;
    };
    return new NodeSqliteWrapper(new nodeSqlite.DatabaseSync(filePath));
  } catch {
    // Older Node.js — fall back to better-sqlite3 (native binary, same ABI).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    return new BetterSqlite3Wrapper(new BetterSqlite3(filePath));
  }
}

// ---------------------------------------------------------------------------
// node:sqlite wrapper
// ---------------------------------------------------------------------------

interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStmt;
  close(): void;
}

interface NodeSqliteStmt {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...args: unknown[]): DbRow[];
  get(...args: unknown[]): DbRow | undefined;
}

class NodeSqliteWrapper implements Db {
  constructor(private readonly db: NodeSqliteDb) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);

    // node:sqlite throws on unknown named params; extract the allowed set so we
    // can silently drop extra keys (matching better-sqlite3 behaviour).
    const allowedKeys = new Set(
      (sql.match(/[@:$](\w+)/g) ?? []).map((p) => p.slice(1)),
    );

    function filterArgs(args: unknown[]): unknown[] {
      if (
        args.length === 1 &&
        args[0] !== null &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0]) &&
        allowedKeys.size > 0
      ) {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) {
          if (allowedKeys.has(k)) filtered[k] = v;
        }
        return [filtered];
      }
      return args;
    }

    return {
      run: (...args) => stmt.run(...filterArgs(args)),
      all: (...args) => (stmt.all(...filterArgs(args)) as DbRow[]),
      get: (...args) => stmt.get(...filterArgs(args)) as DbRow | undefined,
    };
  }

  transaction<T>(fn: (arg: T) => void): (arg: T) => void {
    return (arg: T) => {
      this.db.exec("BEGIN");
      try {
        fn(arg);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// better-sqlite3 wrapper (thin pass-through)
// ---------------------------------------------------------------------------

import type BetterSqlite3 from "better-sqlite3";

class BetterSqlite3Wrapper implements Db {
  constructor(private readonly db: BetterSqlite3.Database) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...args) => {
        const r = stmt.run(...(args as Parameters<typeof stmt.run>));
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
      },
      all: (...args) => stmt.all(...(args as Parameters<typeof stmt.all>)) as DbRow[],
      get: (...args) => stmt.get(...(args as Parameters<typeof stmt.get>)) as DbRow | undefined,
    };
  }

  transaction<T>(fn: (arg: T) => void): (arg: T) => void {
    return this.db.transaction(fn) as (arg: T) => void;
  }

  close(): void {
    this.db.close();
  }
}
