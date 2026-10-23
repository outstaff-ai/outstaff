import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

// Node's built-in SQLite, so there is no native addon to build. Kysely only
// needs a driver; this one keeps a single connection and serialises users.
class NodeSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: DatabaseSync) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const stmt: StatementSync = this.db.prepare(query.sql);
    const params = query.parameters as never[];
    if (stmt.columns().length > 0) {
      return { rows: stmt.all(...params) as R[] };
    }

    const res = stmt.run(...params);
    return { rows: [], numAffectedRows: BigInt(res.changes) };
  }

  streamQuery(): AsyncIterableIterator<never> {
    throw new Error("streaming is not supported by the node:sqlite driver");
  }
}

class NodeSqliteDriver implements Driver {
  #db: DatabaseSync | undefined;
  #conn: NodeSqliteConnection | undefined;
  #tail: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (this.path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
    }

    this.#db = db;
    this.#conn = new NodeSqliteConnection(db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const prev = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((r) => (release = r));
    await prev;
    this.#release = release;
    return this.#conn!;
  }

  // IMMEDIATE takes the write lock up front, so a read-then-write transaction
  // (dequeue) cannot be interleaved with another writer.
  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "begin immediate", parameters: [] } as unknown as CompiledQuery);
  }
  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "commit", parameters: [] } as unknown as CompiledQuery);
  }
  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery({ sql: "rollback", parameters: [] } as unknown as CompiledQuery);
  }

  async releaseConnection(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }

  async destroy(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
  }
}

export function nodeSqliteDialect(path: string): Dialect {
  return {
    createDriver: () => new NodeSqliteDriver(path),
    createAdapter: () => new SqliteAdapter(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
