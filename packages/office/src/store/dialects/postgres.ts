import { PostgresDialect } from "kysely";
import { Client, Pool } from "pg";
import type { PostgresOptions } from "./types.js";

export async function ensureSchema(url: string, schema: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create schema if not exists ${quoteIdent(schema)}`);
  } finally {
    await client.end();
  }
}

export function postgresDialect(url: string, opts: PostgresOptions): PostgresDialect {
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });

  return new PostgresDialect({ pool });
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid schema name: ${name}`);
  }

  return `"${name}"`;
}
