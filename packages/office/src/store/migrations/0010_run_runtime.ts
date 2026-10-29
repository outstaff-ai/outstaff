import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

export const runRuntime: Migration = {
  async up(db: Kysely<unknown>) {
    // Runs older than these columns keep a null: which runtime and model ran them is not known.
    await db.schema.alterTable("runs").addColumn("runtime", "text").execute();
    await db.schema.alterTable("runs").addColumn("model", "text").execute();
  },
};
