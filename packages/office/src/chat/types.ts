import type { ChatOrigin, Link } from "@outstaff/protocol";

export interface ChatOriginRecord extends ChatOrigin {
  /**
   * Other threads linked to the item, because a request from them was attached to it. Each gets the item's result,
   * besides the thread in `channel` and `thread`.
   */
  also?: ChatOrigin[];

  /** The request waits last until the requester says where it goes. */
  awaitingPlacement: boolean;

  /** The message that started the session, for the office's own use (it is not offered to the agent). */
  text?: string;

  /** For a chat session: the requests it has filed so far (normalized), so the same one is not filed twice. */
  requests?: string[];

  /** For a chat session: the work item it filed last for the message. The thread belongs to that item from then on. */
  filed?: string;

  /** What was already reported to the requester, so a retry does not post again. */
  claimed: string[];
}

export interface PendingReport {
  itemId: string;

  /** The claim key of the ending, so a retried hand-back does not queue it twice. */
  key: string;
  kind: "result" | "blocked";
  summary: string;
  links: Link[];
  at: string;
}

export interface ReportQueue {
  /** Queues the report unless that ending was reported or is queued already. */
  add(person: string, report: PendingReport): Promise<void>;

  /** What waits for the person, oldest first. */
  list(person: string): Promise<PendingReport[]>;

  /** Whether that ending was reported already (posted by the agent, or handed to it). */
  done(person: string, itemId: string, key: string): Promise<boolean>;

  /** The agent posted (or was handed) the ending of the item: it is not queued any more and never queued again. */
  settle(person: string, itemId: string, key: string): Promise<void>;
}

export type ParsedPlacement =
  | { type: "next" }
  | { type: "last" }
  | { type: "pm" }
  | { type: "after"; itemIds: string[] };

/** One line of the list the requester saw: a piece of work and the ids of all its items. */
export interface Candidate {
  ids: string[];
  title: string;
  ticketKey?: string | undefined;
}

/** One message of a chat thread as the office received it. The text is data from its author. */
export interface ChatLogEntry {
  messageId: string;
  author: { id: string; name?: string | undefined };
  at: string;
  text: string;
}
