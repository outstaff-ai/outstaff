import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const chatCursors: Migration = {
  async up(db: Kysely<unknown>) {
    // Per person and chat conversation, when the last message the office took in was written: where the agent
    // catches up from when its chat connects again. `thread` is empty for the top level of a channel or DM.
    await db.schema
      .createTable("chat_cursors")
      .addColumn("person", "text", (c) => c.notNull())
      .addColumn("channel", "text", (c) => c.notNull())
      .addColumn("thread", "text", (c) => c.notNull())
      .addColumn("at", "text", (c) => c.notNull())
      .addColumn("updated_at", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("chat_cursors_pk", ["person", "channel", "thread"])
      .execute();

    await db.schema
      .createIndex("chat_cursors_latest")
      .on("chat_cursors")
      .columns(["person", "at"])
      .execute();
  },
};
