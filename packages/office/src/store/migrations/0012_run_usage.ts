import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const runUsage: Migration = {
  async up(db: Kysely<unknown>) {
    // What each run used, per model: the part of its sessions' running totals that was new in the run.
    await db.schema
      .createTable("run_usage")
      .addColumn("run_id", "text", (c) => c.notNull().references("runs.id"))
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("input_tokens", "bigint", (c) => c.notNull())
      .addColumn("output_tokens", "bigint", (c) => c.notNull())
      .addColumn("cache_read_tokens", "bigint", (c) => c.notNull())
      .addColumn("cache_creation_tokens", "bigint", (c) => c.notNull())
      .addColumn("cost_usd", "double precision")
      .addPrimaryKeyConstraint("run_usage_pk", ["run_id", "model"])
      .execute();

    // The latest running total each runtime session reported, per model, to tell what a later report adds.
    await db.schema
      .createTable("session_usage")
      .addColumn("session_id", "text", (c) => c.notNull())
      .addColumn("model", "text", (c) => c.notNull())
      .addColumn("input_tokens", "bigint", (c) => c.notNull())
      .addColumn("output_tokens", "bigint", (c) => c.notNull())
      .addColumn("cache_read_tokens", "bigint", (c) => c.notNull())
      .addColumn("cache_creation_tokens", "bigint", (c) => c.notNull())
      .addColumn("cost_usd", "double precision")
      .addColumn("reported_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("session_usage_pk", ["session_id", "model"])
      .execute();

    await db.schema.createIndex("runs_item").on("runs").columns(["work_item_id", "id"]).execute();

    // Never written: usage is in run_usage now.
    await db.schema.alterTable("runs").dropColumn("usage").execute();
  },
};
