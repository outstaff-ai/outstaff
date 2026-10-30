import type { Logger, Tracker, TeamConfig, Vcs } from "@outstaff/core";
import type { Link } from "@outstaff/protocol";
import type { RosterOptions } from "./messaging/index.js";
import type { BlockNotice, Scheduler } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";
import type { TraceStore } from "./pipeline/trace.types.js";

export interface HandBackResult {
  summary: string;
  links: Link[];
  status: "done" | "waiting" | "blocked" | "interrupted";
}

export interface WorkSourceOptions {
  scheduler: Scheduler;
  store: Store;
  team: Pick<TeamConfig, "people" | "humans"> & Partial<Pick<TeamConfig, "pipeline">>;
  ports?: { tracker?: Tracker; vcs?: Vcs };
  roles?: RosterOptions["roles"];

  /** Where the event pipeline keeps its traces; what each wake's bundle carried is added to them. */
  traces?: Pick<TraceStore, "get" | "record">;

  /** Where a wake whose context could not be built is reported. */
  logger?: Pick<Logger, "warn">;

  /** Called after the item left `active` because of a hand-back, so the office can react (judge it, report it). */
  onHandedBack?: (item: WorkItem, result: HandBackResult) => Promise<void>;

  /** Called after the scheduler blocked an item on its own (repeated failures, loop guard), so the requester hears of it. */
  onBlocked?: (notice: BlockNotice) => void | Promise<void>;

  /** Called after an item went back to the queue because the agent asked for it. */
  notify?: (person: string) => void;
}
