import type { Logger, Tracker } from "@outstaff/core";
import type { ActDesk } from "#/pipeline/act/act.types.js";
import type { Store, WorkItem } from "#/store/types.js";
import type { Clock } from "#/types.js";

export interface UsageFieldsOptions {
  store: Pick<
    Store,
    "itemsOfTicket" | "listRunUsage" | "listItemRefs" | "getSubject" | "upsertSubject"
  >;

  /** The office's tracker: it reads parents and sub-tickets. The agents write the fields. */
  tracker: Pick<Tracker, "getIssue" | "listIssues">;
  acts: Pick<ActDesk, "send">;
  clock: Clock;
  log: Pick<Logger, "warn" | "info">;

  /** How long a ticket must be quiet before its fields are written, so a burst of rounds writes once. */
  debounceMs: number;
}

export interface UsageFields {
  /** A round of the item finished: the item's tickets, and in turn their parents, get their totals written. */
  touched(item: WorkItem): Promise<void>;

  /** Drops the writes still waiting. */
  stop(): void;
}
