import { randomUUID } from "node:crypto";
import { type Dialect, Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { ensureSchema, postgresDialect } from "#/store/dialects/postgres.js";
import { nodeSqliteDialect } from "#/store/dialects/sqlite.js";
import { migrationProvider } from "#/store/migrations/index.js";
import type { Database } from "#/store/schema.js";
import type { Moment } from "#/store/types.js";
import { createSqlStore } from "#/store/sql-store.js";

const item = {
  id: "w1",
  person: "sam",
  kind: "assigned",
  priority: 100,
  status: "done" as const,
  parent_id: null,
  subject_type: "ticket",
  subject_ref: "ACME-1",
  title: "Greet visitors",
  session_id: null,
  workspace: null,
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-01T10:00:00.000Z",
  trigger: "human" as const,
  attempts: 1,
  position: 1,
  not_before: null,
};

const run = (id: string, outcome: string | null, finished: string | null) => ({
  id,
  work_item_id: "w1",
  started_at: "2026-10-01T10:01:00.000Z",
  finished_at: finished,
  outcome,
  error: null,
  usage: null,
  runtime: null,
  model: null,
});

/** A store written before the moments existed, then migrated: its items, journal and outcomes are found. */
async function backfills(
  kind: "sqlite" | "postgres",
  dialect: () => Promise<Dialect>,
): Promise<{ found: Moment[]; error: unknown }> {
  const db = new Kysely<Database>({ dialect: await dialect() });
  try {
    const migrator = new Migrator({ db, provider: migrationProvider });
    const before = await migrator.migrateTo("0010_run_runtime");
    await db.insertInto("work_items").values(item).execute();
    await db
      .insertInto("journal")
      .values({
        id: "j1",
        work_item_id: "w1",
        at: "2026-10-01T10:02:00.000Z",
        author: "office",
        text: "The greetings go on the landing page.",
      })
      .execute();

    await db
      .insertInto("runs")
      .values([
        run("r1", "Opened the greeting pull request.", "2026-10-01T10:03:00.000Z"),
        run("r2", null, null),
      ])
      .execute();

    const after = await migrator.migrateToLatest();
    const store = createSqlStore({ db, dialect: kind, now: () => new Date() });
    const found = await store.searchMoments({ person: "sam", text: "greeting", limit: 10 });
    return { found, error: before.error ?? after.error };
  } finally {
    await db.destroy();
  }
}

/** What the backfill finds: the outcome, the journal entry and the item, newest first. */
const BACKFILLED = [
  ["outcome:r1", "outcome", "2026-10-01T10:03:00.000Z", "sam"],
  ["journal:j1", "journal", "2026-10-01T10:02:00.000Z", "office"],
  ["item:w1", "item", "2026-10-01T10:00:00.000Z", null],
];

const summary = (found: Moment[]) => found.map((m) => [m.key, m.kind, m.at, m.actor]);

describe("the recall moments migration", () => {
  it("indexes what a SQLite store already holds", async () => {
    const { found, error } = await backfills("sqlite", async () => nodeSqliteDialect(":memory:"));
    expect(error).toBeUndefined();
    expect(summary(found)).toEqual(BACKFILLED);
    expect(found[0]).toMatchObject({
      subject: { type: "ticket", ref: "ACME-1" },
      workItemId: "w1",
    });
  });

  const pgUrl = process.env["OUTSTAFF_TEST_POSTGRES_URL"] ?? "";
  it.skipIf(!pgUrl)("indexes what a Postgres store already holds", async () => {
    const schema = `t_${randomUUID().replaceAll("-", "")}`;
    await ensureSchema(pgUrl, schema);
    try {
      const { found, error } = await backfills("postgres", async () =>
        postgresDialect(pgUrl, { schema }),
      );

      expect(error).toBeUndefined();
      expect(summary(found)).toEqual(BACKFILLED);
    } finally {
      const client = new Client({ connectionString: pgUrl });
      await client.connect();
      await client.query(`drop schema if exists "${schema}" cascade`);
      await client.end();
    }
  });
});
