import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const doctorChecks: Migration = {
  async up(db: Kysely<unknown>) {
    // The latest result of each doctor check: the office's own (scope `office`) and each agent's.
    await db.schema
      .createTable("doctor_checks")
      .addColumn("scope", "text", (c) => c.notNull())
      .addColumn("name", "text", (c) => c.notNull())
      .addColumn("status", "text", (c) => c.notNull())
      .addColumn("detail", "text", (c) => c.notNull())
      .addColumn("fix", "text")
      .addColumn("key", "text")
      .addColumn("adapter", "text")
      .addColumn("first_seen", "text", (c) => c.notNull())
      .addColumn("last_seen", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("doctor_checks_pk", ["scope", "name"])
      .execute();
  },
};
