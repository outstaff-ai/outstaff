import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const workItemRefs: Migration = {
  async up(db: Kysely<unknown>) {
    // Everything a work item refers to, recorded as soon as the office knows it: when and how it was added.
    await db.schema
      .createTable("work_item_refs")
      .addColumn("work_item_id", "text", (c) => c.notNull().references("work_items.id"))
      .addColumn("ref_type", "text", (c) => c.notNull())
      .addColumn("ref", "text", (c) => c.notNull())
      .addColumn("url", "text")
      .addColumn("role", "text", (c) => c.notNull())
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("added_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("work_item_refs_pk", ["work_item_id", "ref_type", "ref"])
      .execute();

    await db.schema
      .createIndex("work_item_refs_ref")
      .on("work_item_refs")
      .columns(["ref_type", "ref", "added_at"])
      .execute();

    // Edges older than this column keep a null time: when they were linked is not known.
    await db.schema.alterTable("links").addColumn("created_at", "text").execute();
  },
};
