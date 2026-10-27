import type { Chat, Logger, TeamConfig, Tracker } from "@outstaff/core";
import type {
  Attached,
  ChatOrigin,
  Filed,
  Link,
  QueuedReport,
  WorkSummary,
} from "@outstaff/protocol";
import type { Offer } from "../office-client/index.js";
import type { ChatReportKind, OfficeClient } from "../verbs/office.types.js";
import type { Attachment, ProfilePublisher } from "./types.js";

/** What the relay uses of the office connection. */
export type ChatOffice = Pick<
  OfficeClient,
  "chatMessage" | "chatReport" | "reportPosted" | "currentWork" | "work"
>;

/** What a chat session filed, for the first reply: a new ticket, a request, or the existing work it joined. */
export interface FiledWhat {
  key?: string;
  title: string;
  attached?: Attached["attached"];
}

export interface ChatRelayOptions {
  chat: Chat;
  office: ChatOffice;
  team: TeamConfig;
  person: string;
  tracker?: Pick<Tracker, "links">;
  log?: Logger;

  /** Publishes the agent's chat profile while the relay listens. */
  profile?: Pick<ProfilePublisher, "start" | "stop">;

  /** Messages of the conversation a new chat session starts with. Default 10. */
  historyLimit?: number;
}

export interface ChatRelay {
  /** Starts listening on the agent's own chat identity. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Downloads the files the requester shared in the message that started the item into `dir`. Files that are not
   * images or text, or are over the size cap, or fail to download, are listed without a copy. Never throws.
   */
  attachments(offer: Offer, dir: string): Promise<Attachment[]>;

  /** What a new chat session starts with: the recent conversation and the person's current work. */
  context(offer: Offer): Promise<string | undefined>;

  /**
   * First reply in the thread, once the chat session filed the request as work: what tracks it, and when the person
   * is busy the work in the order it runs and the question where it goes. Posted once per item.
   */
  acknowledge(offer: Offer, what: FiledWhat, filed: Filed): Promise<void>;

  /**
   * Tells the requester how an item ended, as the agent: a chat item in the thread it came from, and a blocked
   * item the office has the agent report (the team routes blocked work to the agent) in the requester's direct
   * message when it did not come from chat. Nothing is posted for anything else, or one already reported.
   */
  report(
    offer: Offer,
    kind: Exclude<ChatReportKind, "ack">,
    text: string,
    links?: Link[],
  ): Promise<void>;

  /**
   * Posts the reports the agent was offline for, as itself: the office queued them and handed them over when the
   * agent connected. Never throws.
   */
  postQueued(reports: QueuedReport[]): Promise<void>;
}

/** What reading a chat item's context needs from the relay. */
export interface ChatContextDeps {
  chat: Chat;
  office: ChatOffice;
  log: Logger;
  historyLimit: number;

  /** The numbered list of the agent's work: one line per piece of work. */
  describe(work: WorkSummary[]): string[];
}

/** The threads a report belongs to, and the requester to message directly when there are none. */
export interface ReportDestination {
  direct?: string;
  threads: Pick<ChatOrigin, "channel" | "thread" | "direct" | "participant" | "requester">[];
}

/** One place a report is posted, and how the requester is tagged there. */
export interface ReportTarget {
  channel: string;
  thread?: string;
  mention: string;
}
