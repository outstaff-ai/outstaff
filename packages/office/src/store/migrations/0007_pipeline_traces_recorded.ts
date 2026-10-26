import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const pipelineTracesRecorded: Migration = {
  async up(db: Kysely<unknown>) {
    // The office link ships traces in the order they were recorded.
    await db.schema
      .createIndex("pipeline_traces_recorded")
      .on("pipeline_traces")
      .columns(["recorded_at", "ref"])
      .execute();
  },
};
