import type { Logger, Tracker, TeamConfig, Vcs } from "@outstaff/core";
import type { Link } from "@outstaff/protocol";
import type { RosterOptions } from "./messaging/index.js";
import type { BlockNotice, Scheduler } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";
import type { TraceStore } from "./pipeline/trace.types.js";
import type { WorkState } from "./workstate/index.js";

export interface HandBackResult {
  summary: string;
  links: Link[];
  status: "done" | "waiting" | "blocked" | "silent" | "interrupted";

  /** For a done hand-back: what there is to review or what finished, as the agent's check found it. */
  toReview?: string[] | undefined;
}

export interface WorkSourceOptions {
  scheduler: Scheduler;
  store: Store;
  team: Pick<TeamConfig, "people" | "humans"> & Partial<Pick<TeamConfig, "pipeline">>;
  ports?: { tracker?: Tracker; vcs?: Vcs };

  /**
   * The work state, whose pull requests a merge's context names. A `done` hand-back that does not say what it leaves
   * to review (an older agent) is checked against it, and taken as `blocked` when it leaves nothing.
   */
  workState?: Pick<WorkState, "repoPrs" | "ticket" | "prsOfTicket" | "refreshTicket">;
  roles?: RosterOptions["roles"];

  /** Where the event pipeline keeps its traces; what each wake's bundle carried is added to them. */
  traces?: Pick<TraceStore, "get" | "record">;

  /** Where a wake whose context could not be built is reported. */
  logger?: Pick<Logger, "warn">;

  /** Called after the agent accepted an item, before it hears back, so the office can react (judge its start). */
  onAccepted?: (item: WorkItem) => Promise<void>;

  /** Called after the item left `active` because of a hand-back, so the office can react (judge it, report it). */
  onHandedBack?: (item: WorkItem, result: HandBackResult) => Promise<void>;

  /** Called after the scheduler blocked an item on its own (repeated failures, loop guard), so the requester hears of it. */
  onBlocked?: (notice: BlockNotice) => void | Promise<void>;

  /** Called after an item went back to the queue because the agent asked for it. */
  notify?: (person: string) => void;
}
