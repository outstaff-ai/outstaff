import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const eventDelivery: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable("events").addColumn("processed_at", "text").execute();
    await db.schema
      .alterTable("events")
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema.alterTable("events").addColumn("process_error", "text").execute();
    await db.schema
      .createIndex("events_unprocessed")
      .on("events")
      .columns(["processed_at", "received_at"])
      .execute();
  },
};
