import type {
  AnswerState,
  ErrorCode,
  Filed,
  Human,
  Link,
  Member,
  PayloadOf,
  WorkSummary,
} from "@outstaff/protocol";

export type Offer = PayloadOf<"offer">;

/** Thrown by a source to answer a request with a specific error code. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/**
 * What the protocol server needs from the scheduler and store. The server keeps no state that must survive a
 * restart: which items were offered and accepted lives behind this interface. Every call is scoped to the person
 * whose connection made it; an item of someone else is `unknown_item`.
 */
export interface WorkSource {
  /** Items handed to the person and not finished yet, with whether the agent accepted them. */
  outstanding(person: string): Promise<{ offer: Offer; accepted: boolean }[]>;

  /** Takes the next queued item for the person, or nothing when they are busy or the queue is empty. */
  next(person: string): Promise<Offer | undefined>;

  /** Idempotent. */
  accept(person: string, workItemId: string): Promise<void>;

  /**
   * Puts an offered item back in the queue, untouched: no failure is counted, and the journal and stored session
   * stay. Also used for an accepted, unfinished item after the agent restarted.
   */
  decline(person: string, workItemId: string, reason: string): Promise<void>;
  heartbeat(person: string, workItemId: string | undefined): Promise<void>;
  progress(person: string, workItemId: string, text: string): Promise<void>;

  /** Stores the runtime session of the item; the offer of a later round carries it. */
  setSession(person: string, workItemId: string, sessionId: string): Promise<void>;
  journal(person: string, workItemId: string, text: string): Promise<void>;
  handBack(
    person: string,
    workItemId: string,
    result: { summary: string; links: Link[]; status: "done" | "waiting" | "blocked" },
  ): Promise<void>;

  /** Counts a failed run: the item is held back with backoff, and blocked after repeated failures. */
  fail(person: string, workItemId: string, reason: string): Promise<void>;

  roster(): Promise<Member[]>;
  list(person: string, q: { workItemId?: string }): Promise<WorkSummary[]>;
  move(
    person: string,
    workItemId: string,
    status: "queued" | "blocked" | "canceled",
  ): Promise<WorkSummary>;

  /** Puts one of the person's queued items at a place in their queue. */
  place(
    person: string,
    workItemId: string,
    position: "next" | "last" | "before" | "after",
    relativeTo?: string,
  ): Promise<WorkSummary>;
}

/** Chat requests of trusted humans, and the report back to them. Optional: without it chat messages are unsupported. */
export interface ChatDesk {
  message(person: string, m: PayloadOf<"chat_message">): Promise<PayloadOf<"chat_message_result">>;
  report(
    person: string,
    workItemId: string,
    kind: PayloadOf<"chat_report">["kind"],
  ): Promise<PayloadOf<"chat_report_result">>;

  /** The person's open tickets and pull requests, as text. */
  currentWork(person: string): Promise<string>;

  /**
   * Files the ticket a chat session created as work: a work item for the ticket, in the session's thread. It starts
   * when the person is idle and otherwise waits last until the requester says where it goes.
   */
  linkTicket(person: string, workItemId: string, ticket: string): Promise<Filed>;

  /** Files work that has no tracker: a work item for the request, in the session's thread. Like `linkTicket`. */
  queueWork(
    person: string,
    workItemId: string,
    request: { title: string; body: string },
  ): Promise<Filed>;
}

/** Agent-to-agent questions. Optional until the messaging component exists; without it `ask` is unsupported. */
export interface Messaging {
  ask(
    from: string,
    q: { to: string; question: string; workItemId?: string | undefined },
  ): Promise<AnswerState>;
  answer(from: string, questionId: string, answer: string): Promise<void>;

  /**
   * Called after an agent handed an item back. Answers that arrived while the item was running are delivered then:
   * the item is queued again with them in its journal.
   */
  onHandBack?(itemId: string, status: string): Promise<void>;

  /** The team as agents see it, including the trusted humans. Without it the work source's members are shown. */
  roster?(): Promise<{ members: Member[]; humans: Human[] }>;
}
