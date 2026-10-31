import type { TeamConfig, Tracker } from "@outstaff/core";
import type { Filed, Link } from "@outstaff/protocol";
import type { ChatDesk } from "#/protocol/source.types.js";
import type { Scheduler } from "#/scheduler/types.js";
import type { Store, WorkItem } from "#/store/types.js";
import type { Clock } from "#/types.js";
import type { WorkState } from "#/workstate/index.js";
import type { ChatOriginRecord } from "./types.js";

export interface ChatDeskOptions {
  store: Store;

  /** The scheduler without the notifying wrapper: the desk stores the origin first and then calls `notify`. */
  scheduler: Pick<Scheduler, "enqueue" | "retry">;
  team: Pick<TeamConfig, "people" | "policies"> & Partial<Pick<TeamConfig, "integrations">>;
  workState: Pick<
    WorkState,
    "currentWork" | "pullRequests" | "ticket" | "prSubject" | "lastWorker" | "catchUp"
  >;
  tracker?: Pick<Tracker, "links">;

  /**
   * The chat user id of the human who asked for the item's work, for the blocked report of an item that did not
   * come from chat. Undefined when there is no known requester or no chat identity for them.
   */
  requesterChat?: (item: WorkItem) => Promise<string | undefined>;

  /** Pull requests and tickets of an item, as links. */
  linksOf: (item: WorkItem) => Promise<Link[]>;
  notify: (person: string) => void;

  /** Tells the server to send the person's queued reports now; the agent also gets them when it connects. */
  push?: (person: string) => void;

  clock?: Clock;
}

/** What the office's chat handling does besides taking messages in: the filing and attach verbs, and the reports. */
export interface ChatRequests extends Omit<ChatDesk, "message"> {
  /**
   * An item the scheduler blocked (the agent did not hand it back): queues the report its agent owes the requester,
   * so the agent posts it as itself (the thread of a chat item, else a direct message), live if connected and
   * otherwise on its next connection. Without a chat thread, only when the blocked agent reports blocked work itself.
   */
  blocked(item: WorkItem, reason: string): Promise<void>;

  /**
   * Records the hand-back of an item whose requester is to hear how it ended: the chat result of a chat item, and
   * the blocked report when the blocked agent reports itself. The agent claims it with `chat_report`; if it did not
   * (it was offline), `queued` hands it over when the agent connects. The office posts nothing.
   */
  handedBack(item: WorkItem, result: { summary: string; links: Link[] }): Promise<void>;
}

/** The chat session a filing verb was called from, with its origin. */
export interface DeskSession {
  session: WorkItem;
  origin: ChatOriginRecord;
}

/** What a chat session files: a work item of its own, in the session's thread. */
export interface FileSpec {
  kind: string;
  title: string;
  request: string;
  subject: { type: string; ref: string };
  note: string;

  /** The verb that filed it. */
  source: string;
}

/** Filing from a chat session, shared by the filing and attach verbs. */
export interface DeskFiling {
  /** The chat session a filing verb was called from; refused for anything else, or a request it filed already. */
  sessionOf(person: string, sessionId: string, request: string): Promise<DeskSession>;

  /** Two filings are the same request when their wording is, ignoring case and spacing. */
  requestKey(request: string): string;
  file(person: string, sessionId: string, spec: FileSpec): Promise<Filed>;

  /** Notes a request the session filed for someone else, so it is not filed twice; no work item is created. */
  record(person: string, sessionId: string, request: string): Promise<void>;
}
