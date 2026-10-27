import { Kysely, type Dialect } from "kysely";
import { Migrator } from "kysely/migration";
import { ensureSchema, postgresDialect } from "./dialects/postgres.js";
import { nodeSqliteDialect } from "./dialects/sqlite.js";
import { migrationProvider } from "./migrations/index.js";
import type { Database } from "./schema.js";
import { createSqlStore } from "./sql-store.js";
import type { OpenStoreOptions, Store } from "./types.js";

const POSTGRES = /^postgres(ql)?:\/\//;
const SQLITE_MEMORY = "sqlite::memory:";
const SQLITE = "sqlite://";

async function postgres(url: string, schema: string | undefined): Promise<Dialect> {
  if (schema) {
    await ensureSchema(url, schema);
  }

  return postgresDialect(url, schema ? { schema } : {});
}

function sqlite(url: string): Dialect {
  if (url === SQLITE_MEMORY) {
    return nodeSqliteDialect(":memory:");
  }

  const path = url.slice(SQLITE.length);
  if (!path) {
    throw new Error("sqlite url has no path");
  }

  return nodeSqliteDialect(path);
}

/** The database the url names, and its kind. */
async function connect(url: string, schema: string | undefined) {
  if (POSTGRES.test(url)) {
    return { dialect: "postgres" as const, kysely: await postgres(url, schema) };
  }

  if (url === SQLITE_MEMORY || url.startsWith(SQLITE)) {
    return { dialect: "sqlite" as const, kysely: sqlite(url) };
  }

  throw new Error(
    "unsupported store url: expected postgres://…, sqlite:///path or sqlite::memory:",
  );
}

/** Brings the schema up to date; a database that cannot be migrated is closed. */
async function migrate(db: Kysely<Database>): Promise<void> {
  try {
    const { error } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest();
    if (error) {
      throw error;
    }
  } catch (err) {
    await db.destroy();
    throw err;
  }
}

/**
 * `postgres://…` / `postgresql://…`, `sqlite:///abs/path.db` (or `sqlite://relative.db`),
 * or `sqlite::memory:`.
 */
export async function openStore(url: string, opts: OpenStoreOptions = {}): Promise<Store> {
  const now = opts.now ?? (() => new Date());
  const { dialect, kysely } = await connect(url, opts.schema);
  const db = new Kysely<Database>({ dialect: kysely });
  if (opts.migrate ?? true) {
    await migrate(db);
  }

  return createSqlStore({ db, dialect, now });
}
