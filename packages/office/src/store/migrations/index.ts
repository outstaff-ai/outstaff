import type { MigrationProvider } from "kysely/migration";
import { init } from "./0001_init.js";
import { eventDelivery } from "./0002_event_delivery.js";
import { queueOrderAndPauses } from "./0003_queue_order_and_pauses.js";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "0001_init": init,
      "0002_event_delivery": eventDelivery,
      "0003_queue_order_and_pauses": queueOrderAndPauses,
    };
  },
};
