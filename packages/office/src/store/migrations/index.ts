import type { MigrationProvider } from "kysely/migration";
import { init } from "./0001_init.js";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { "0001_init": init };
  },
};
