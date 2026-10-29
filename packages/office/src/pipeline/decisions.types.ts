import type { ActOp } from "@outstaff/core";
import type { Feedback } from "@outstaff/protocol";

export type { ActOp, ActTarget } from "@outstaff/core";

/** What a woken agent's run is about; the key coalescing groups by, together with the person. */
export interface WakeSubject {
  type: "pr" | "ticket" | "doc" | "chat";

  /** `owner/name#n` for a pull request, the key of a ticket, the id of a document, `channel:thread` (or the channel, for a direct message's top-level messages) for chat. */
  ref: string;
}

/** Schedule an agent run. The instruction says what is expected; the agent decides how. */
export interface Wake {
  type: "wake";
  policy: string;
  person: string;
  kind: string;
  instruction: string;

  /** The reviews, comments or messages the run must act on, oldest first. */
  feedback: Feedback[];
  subject: WakeSubject;

  /** The work item the wake queued, or joined; set once the live pipeline has queued it. */
  itemId?: string | undefined;

  /**
   * Set when the wake was folded into an item an earlier wake queued, coalesced within `pipeline.wake.coalesce_seconds`
   * or joining work of the same kind: every event of that item so far, this one last.
   */
  folded?: string[] | undefined;
}

/**
 * Change the tracker on behalf of `as`, without a model run and without waking them. The office makes the changes
 * with its own account, and posts `note` with them, saying whom they are for.
 */
export interface Act {
  type: "act";
  policy: string;

  /** The agent the changes are made for. */
  as: string;
  ops: ActOp[];

  /** The comment the office posts on the ticket with the changes. */
  note?: string | undefined;
}

/** Nothing happens; recorded so it can be explained. */
export interface Drop {
  type: "drop";

  /** The policy that decided it, or none when no policy matched or a gate stopped the event. */
  policy?: string | undefined;
  reason: string;
}

export type Decision = Wake | Act | Drop;
