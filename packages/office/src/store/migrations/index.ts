import type { MigrationProvider } from "kysely/migration";
import { init } from "./0001_init.js";
import { eventDelivery } from "./0002_event_delivery.js";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return { "0001_init": init, "0002_event_delivery": eventDelivery };
  },
};
