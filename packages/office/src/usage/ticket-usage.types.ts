import type { Logger, Tracker } from "@outstaff/core";
import type { Store } from "#/store/types.js";

export interface TicketUsageDeps {
  store: Pick<Store, "itemsOfTicket" | "listRunUsage">;

  /** The office's tracker, to read which tickets are sub-tickets; without it nothing is rolled up. */
  tracker?: Pick<Tracker, "listIssues"> | undefined;
  log: Pick<Logger, "warn">;
}
