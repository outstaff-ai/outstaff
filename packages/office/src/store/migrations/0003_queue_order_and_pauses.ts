import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

export const queueOrderAndPauses: Migration = {
  async up(db: Kysely<unknown>) {
    // Existing rows tie at 0 and keep their created_at order.
    await db.schema
      .alterTable("work_items")
      .addColumn("position", "integer", (c) => c.notNull().defaultTo(sql`0`))
      .execute();

    await db.schema
      .createIndex("work_items_order")
      .on("work_items")
      .columns(["person", "status", "priority", "position", "created_at"])
      .execute();

    await db.schema
      .createTable("pauses")
      .addColumn("scope", "text", (c) => c.primaryKey())
      .addColumn("reason", "text")
      .addColumn("paused_at", "text", (c) => c.notNull())
      .execute();
  },
};
