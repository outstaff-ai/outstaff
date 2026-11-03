import type { Logger, TeamConfig, Tracker } from "@outstaff/core";
import type { NoticePr } from "@outstaff/policy";
import type { Clock } from "#/types.js";
import type { Store } from "#/store/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ActDesk } from "#/pipeline/act/act.types.js";
import type { Notify } from "#/pipeline/decisions.types.js";

/** One notice the office holds for a human: what one event's policy decided. */
export interface NoticeEntry {
  /** The event that decided it; the same event delivered again adds nothing. */
  event: string;

  /** When the office took it (ISO-8601). */
  at: string;
  need: Notify["need"];
  ticket?: string | undefined;
  prs: NoticePr[];
  text?: string | undefined;
}

/** A human's notices from one agent, waiting to go as one direct message. */
export interface PendingNotices {
  as: string;
  human: string;

  /** When the first and the latest notice came (ISO-8601). */
  first: string;
  last: string;
  entries: NoticeEntry[];
}

/** What the office remembers it sent, so an event delivered again or a late duplicate sends nothing more. */
export interface SentNotice {
  key: string;
  at: string;
}

export interface NoticeBook {
  pending: PendingNotices[];
  sent: SentNotice[];
}

/** A human's notices about one ticket (or one pull request without a ticket), merged. */
export interface NoticeGroup {
  need: Notify["need"];
  ticket?: string | undefined;
  prs: NoticePr[];
  text?: string | undefined;
}

/** One line of a message: a ticket (or a pull request without one), with its pull requests and what is needed. */
export interface NoticeItem {
  need: Notify["need"];
  ticket?: { key: string; url?: string | undefined; title?: string | undefined } | undefined;
  prs: NoticePr[];
  text?: string | undefined;
}

export interface NoticeDeskOptions {
  team: Pick<TeamConfig, "humans" | "people" | "pipeline" | "office">;
  store: Pick<Store, "getSubject" | "upsertSubject" | "listItems" | "listRuns">;
  workState: Pick<WorkState, "inRound" | "ticket">;
  acts: Pick<ActDesk, "send">;
  clock: Clock;
  logger: Logger;

  /** The office's own tracker: ticket links, and the escalating agent's comment when a notice has no text. */
  tracker?: Pick<Tracker, "links" | "listComments"> | undefined;
}

/**
 * Holds the notices the pipeline decides and sends each human's as one direct message from the agent, once no new
 * one came for the debounce window and the agent's round on their tickets is over.
 */
export interface NoticeDesk {
  /**
   * `at` is when the event happened: an assignment made in a chat session with the very human it goes to (they asked
   * for it there) tells them nothing new, and is not sent.
   */
  add(notice: Notify, eventId: string, at?: string): Promise<void>;

  /** Sends what is due; the scheduler's tick calls it too, so notices held over a restart go out. Never throws. */
  flush(): Promise<void>;

  /** Cancels the debounce timers; what is still held is sent after the next start. */
  stop(): void;
}
