import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const conversationDelivery: Migration = {
  async up(db: Kysely<unknown>) {
    // Null until the answer reached the asker's work item in a run; old answered rows count as not delivered.
    await db.schema.alterTable("conversations").addColumn("delivered_at", "text").execute();
    await db.schema
      .createIndex("conversations_asker")
      .on("conversations")
      .columns(["asker_item_id", "status"])
      .execute();
  },
};
