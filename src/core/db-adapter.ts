/**
 * SQLite abstraction that prefers the built-in `node:sqlite` module
 * (stable in Node 23.4+, experimental in Node 22.5+) and falls back to
 * `sql.js` — a pure-JavaScript/WebAssembly SQLite build with zero native
 * binaries. This ensures the extension works on Windows, macOS, and Linux
 * regardless of Node.js ABI version or architecture.
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
// Factory — async because sql.js initialisation is asynchronous
// ---------------------------------------------------------------------------

export async function openDb(filePath: string): Promise<Db> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // 1) Prefer node:sqlite (Node 23.4+ stable; Node 22.5+ experimental).
  //    We test instantiation, not just import, to catch the case where the
  //    module exists but the runtime flag hasn't been set.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeSqlite = require("node:sqlite") as {
      DatabaseSync: new (path: string) => NodeSqliteDb;
    };
    const db = new nodeSqlite.DatabaseSync(filePath);
    return new NodeSqliteWrapper(db);
  } catch {
    // Not available — fall through to sql.js.
  }

  // 2) Universal fallback: sql.js (pure JS + WebAssembly, no native binary).
  //    Works on Windows, macOS, Linux, any Node version.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require("sql.js") as (config?: {
    wasmBinary?: Uint8Array;
    locateFile?: (file: string) => string;
  }) => Promise<SqlJsStatic>;

  // Resolve wasm binary from node_modules so it works regardless of CWD.
  let sqlJsConfig: { wasmBinary?: Uint8Array } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    sqlJsConfig = { wasmBinary: new Uint8Array(fs.readFileSync(wasmPath)) };
  } catch {
    // If resolve fails, sql.js will attempt its own file lookup.
  }

  const SQL = await initSqlJs(sqlJsConfig);
  const fileBuffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const sqlDb = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  return new SqlJsWrapper(sqlDb, filePath, SQL);
}

// ---------------------------------------------------------------------------
// node:sqlite wrapper (synchronous built-in)
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
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// sql.js wrapper (pure-JS fallback, works everywhere)
// ---------------------------------------------------------------------------

interface SqlJsStatic {
  Database: new (data?: Buffer | Uint8Array | null) => SqlJsDb;
}

interface SqlJsDb {
  run(sql: string, params?: unknown): SqlJsDb;
  prepare(sql: string): SqlJsStmt;
  export(): Uint8Array;
  getRowsModified(): number;
  close(): void;
}

interface SqlJsStmt {
  run(params?: unknown): SqlJsStmt;
  bind(params?: unknown): boolean;
  step(): boolean;
  getAsObject(params?: unknown): Record<string, unknown>;
  free(): boolean;
  reset(): void;
}

class SqlJsWrapper implements Db {
  constructor(
    private readonly sqlDb: SqlJsDb,
    private readonly filePath: string,
    private readonly SQL: SqlJsStatic,
  ) {}

  exec(sql: string): void {
    this.sqlDb.run(sql);
  }

  prepare(sql: string): Statement {
    const { sqlDb } = this;

    /**
     * sql.js named params REQUIRE the sigil prefix in the bound object key:
     *   SQL: `WHERE id = @id`  →  bind object: `{"@id": value}` (NOT `{id: value}`)
     *
     * Our code (and better-sqlite3) passes objects WITHOUT the prefix, so we
     * add it here.  Positional params (multiple spread values) are wrapped
     * into an array.
     */
    function normParams(args: unknown[]): unknown {
      if (args.length === 0) return undefined;
      if (
        args.length === 1 &&
        args[0] !== null &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0])
      ) {
        // Named-param object → add @ prefix to every key that lacks a sigil.
        const obj = args[0] as Record<string, unknown>;
        const prefixed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k.startsWith("@") || k.startsWith(":") || k.startsWith("$")) {
            prefixed[k] = v;
          } else {
            prefixed[`@${k}`] = v;
          }
        }
        return prefixed;
      }
      // Positional: wrap spread args into array.
      return args;
    }

    return {
      run(...args: unknown[]) {
        const stmt = sqlDb.prepare(sql);
        const params = normParams(args);
        // sql.js stmt.run() binds + executes one step (good for writes)
        stmt.run(params);
        stmt.free();
        return { changes: sqlDb.getRowsModified(), lastInsertRowid: 0 as number };
      },

      all(...args: unknown[]): DbRow[] {
        const stmt = sqlDb.prepare(sql);
        const params = normParams(args);
        if (params !== undefined) stmt.bind(params);
        const rows: DbRow[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as DbRow);
        }
        stmt.free();
        return rows;
      },

      get(...args: unknown[]): DbRow | undefined {
        const stmt = sqlDb.prepare(sql);
        const params = normParams(args);
        if (params !== undefined) stmt.bind(params);
        const found = stmt.step();
        const row = found ? (stmt.getAsObject() as DbRow) : undefined;
        stmt.free();
        return row;
      },
    };
  }

  transaction<T>(fn: (arg: T) => void): (arg: T) => void {
    return (arg: T) => {
      this.sqlDb.run("BEGIN");
      try {
        fn(arg);
        this.sqlDb.run("COMMIT");
        this._persist(); // flush in-memory DB to disk after each commit
      } catch (err) {
        try { this.sqlDb.run("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    };
  }

  /** Write the in-memory database back to the file. */
  private _persist(): void {
    const data = this.sqlDb.export();
    fs.writeFileSync(this.filePath, Buffer.from(data));
  }

  close(): void {
    this._persist();
    this.sqlDb.close();
  }
}
