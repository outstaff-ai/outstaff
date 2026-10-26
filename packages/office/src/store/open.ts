import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { ensureSchema, postgresDialect } from "./dialects/postgres.js";
import { nodeSqliteDialect } from "./dialects/sqlite.js";
import { migrationProvider } from "./migrations/index.js";
import type { Database } from "./schema.js";
import { createSqlStore } from "./sql-store.js";
import type { OpenStoreOptions, Store } from "./types.js";

/**
 * `postgres://…` / `postgresql://…`, `sqlite:///abs/path.db` (or `sqlite://relative.db`),
 * or `sqlite::memory:`.
 */
export async function openStore(url: string, opts: OpenStoreOptions = {}): Promise<Store> {
  const now = opts.now ?? (() => new Date());
  let dialect: "postgres" | "sqlite";
  let kyselyDialect;
  if (/^postgres(ql)?:\/\//.test(url)) {
    dialect = "postgres";
    if (opts.schema) {
      await ensureSchema(url, opts.schema);
    }

    kyselyDialect = postgresDialect(url, opts.schema ? { schema: opts.schema } : {});
  } else if (url === "sqlite::memory:") {
    dialect = "sqlite";
    kyselyDialect = nodeSqliteDialect(":memory:");
  } else if (url.startsWith("sqlite://")) {
    dialect = "sqlite";
    const path = url.slice("sqlite://".length);
    if (!path) {
      throw new Error("sqlite url has no path");
    }

    kyselyDialect = nodeSqliteDialect(path);
  } else {
    throw new Error(
      "unsupported store url: expected postgres://…, sqlite:///path or sqlite::memory:",
    );
  }

  const db = new Kysely<Database>({ dialect: kyselyDialect });
  try {
    if (opts.migrate ?? true) {
      const { error } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest();
      if (error) {
        throw error;
      }
    }
  } catch (err) {
    await db.destroy();
    throw err;
  }

  return createSqlStore({ db, dialect, now });
}
