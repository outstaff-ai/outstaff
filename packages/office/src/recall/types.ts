import type { Links, Logger, PrRef, TeamConfig, WorkflowEvent } from "@outstaff/core";
import type { Store } from "#/store/types.js";
import type { Clock } from "#/types.js";
import type { WorkState } from "#/workstate/index.js";

/** What `--about` reads of the work state: the pull requests it keeps by number, and their keys. */
export type AboutState = Pick<WorkState, "pullRequests" | "prSubject">;

export interface RecallIndexOptions {
  store: Pick<Store, "recordMoment" | "listEventsAfter" | "getCursor" | "setCursor">;

  /** The work state's key of a pull request, as work items refer to it. */
  prKey: (pr: PrRef) => string;
  clock: Clock;
  log: Logger;
}

export interface RecallIndex {
  /** Indexes an event the office judges; never throws. */
  record(event: WorkflowEvent, meta: { source: string; externalId: string }): Promise<void>;

  /** Indexes the events recorded since the last catch-up, from the first when there was none. */
  catchUp(): Promise<void>;
}

export interface RecallOptions {
  store: Pick<
    Store,
    "searchMoments" | "getSubject" | "recordMoment" | "listEventsAfter" | "getCursor" | "setCursor"
  >;
  team: TeamConfig;
  workState: AboutState;
  clock: Clock;
  log: Logger;

  /** The tracker's links, for a ticket the work state no longer keeps. */
  tracker?: { links: Pick<Links, "issue"> } | undefined;
}
