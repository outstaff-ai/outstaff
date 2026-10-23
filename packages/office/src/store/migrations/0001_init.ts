import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

export const init: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("cursors")
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("key", "text", (c) => c.notNull())
      .addColumn("value", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("cursors_pk", ["source", "key"])
      .execute();

    await db.schema
      .createTable("events")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("source", "text", (c) => c.notNull())
      .addColumn("external_id", "text", (c) => c.notNull())
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("payload", "text", (c) => c.notNull())
      .addColumn("received_at", "text", (c) => c.notNull())
      .addUniqueConstraint("events_dedupe", ["source", "external_id"])
      .execute();

    await db.schema
      .createTable("work_items")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("person", "text", (c) => c.notNull())
      .addColumn("kind", "text", (c) => c.notNull())
      .addColumn("priority", "integer", (c) => c.notNull())
      .addColumn("status", "text", (c) =>
        c.notNull().check(sql`status in ('queued','active','waiting','done','blocked','canceled')`),
      )
      .addColumn("parent_id", "text", (c) => c.references("work_items.id"))
      .addColumn("subject_type", "text")
      .addColumn("subject_ref", "text")
      .addColumn("title", "text", (c) => c.notNull())
      .addColumn("session_id", "text")
      .addColumn("workspace", "text")
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addColumn("trigger", "text", (c) =>
        c.notNull().check(sql`trigger in ('human','agent','automation','schedule')`),
      )
      .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema
      .createIndex("work_items_queue")
      .on("work_items")
      .columns(["person", "status", "priority", "created_at"])
      .execute();

    await db.schema
      .createTable("runs")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("work_item_id", "text", (c) => c.notNull().references("work_items.id"))
      .addColumn("started_at", "text", (c) => c.notNull())
      .addColumn("finished_at", "text")
      .addColumn("outcome", "text")
      .addColumn("error", "text")
      .addColumn("usage", "text")
      .execute();

    await db.schema
      .createTable("journal")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("work_item_id", "text", (c) => c.notNull().references("work_items.id"))
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("author", "text", (c) => c.notNull())
      .addColumn("text", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("journal_item")
      .on("journal")
      .columns(["work_item_id", "id"])
      .execute();

    await db.schema
      .createTable("links")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("from_type", "text", (c) => c.notNull())
      .addColumn("from_ref", "text", (c) => c.notNull())
      .addColumn("to_type", "text", (c) => c.notNull())
      .addColumn("to_ref", "text", (c) => c.notNull())
      .addColumn("relation", "text", (c) => c.notNull())
      .addUniqueConstraint("links_edge", ["from_type", "from_ref", "to_type", "to_ref", "relation"])
      .execute();

    await db.schema.createIndex("links_to").on("links").columns(["to_type", "to_ref"]).execute();

    await db.schema
      .createTable("subjects")
      .addColumn("type", "text", (c) => c.notNull())
      .addColumn("ref", "text", (c) => c.notNull())
      .addColumn("data", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("subjects_pk", ["type", "ref"])
      .execute();

    await db.schema
      .createTable("loop_guard")
      .addColumn("work_item_id", "text", (c) => c.notNull().references("work_items.id"))
      .addColumn("at", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex("loop_guard_item")
      .on("loop_guard")
      .columns(["work_item_id", "at"])
      .execute();

    await db.schema
      .createTable("conversations")
      .addColumn("id", "text", (c) => c.primaryKey())
      .addColumn("asker_item_id", "text", (c) => c.notNull().references("work_items.id"))
      .addColumn("target", "text", (c) => c.notNull())
      .addColumn("question", "text", (c) => c.notNull())
      .addColumn("answer", "text")
      .addColumn("status", "text", (c) => c.notNull().check(sql`status in ('open','answered')`))
      .addColumn("depth", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("created_at", "text", (c) => c.notNull())
      .addColumn("answered_at", "text")
      .execute();
  },
};
