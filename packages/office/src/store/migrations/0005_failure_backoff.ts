import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";

export const failureBackoff: Migration = {
  async up(db: Kysely<unknown>) {
    // `failures` counts consecutive failed runs; `not_before` holds a failed item back until then.
    await db.schema
      .alterTable("work_items")
      .addColumn("failures", "integer", (c) => c.notNull().defaultTo(sql`0`))
      .execute();

    await db.schema.alterTable("work_items").addColumn("not_before", "text").execute();
  },
};
