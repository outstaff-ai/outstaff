import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const pipelineTraces: Migration = {
  async up(db: Kysely<unknown>) {
    // One trace per event: what the event pipeline decided and why. Keyed by the event's `<source>:<externalId>`.
    await db.schema
      .createTable("pipeline_traces")
      .addColumn("ref", "text", (c) => c.primaryKey())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("data", "text", (c) => c.notNull())
      .addColumn("recorded_at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("pipeline_traces_at")
      .on("pipeline_traces")
      .columns(["at", "recorded_at"])
      .execute();
  },
};
