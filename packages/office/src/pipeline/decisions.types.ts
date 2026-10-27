import type { CanonicalStatus } from "@outstaff/core";
import type { Feedback } from "@outstaff/protocol";

/** What a woken agent's run is about; the key coalescing groups by, together with the person. */
export interface WakeSubject {
  type: "pr" | "ticket" | "doc" | "chat";

  /** `owner/name#n` for a pull request, the key of a ticket, the id of a document, `channel/thread` for chat. */
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
}

export type ActTarget = { kind: "agent" | "human"; id: string };

/** A tracker or knowledge-base change, made with the acting agent's own identity. */
export type ActOp =
  | { op: "move"; ticket: string; to: CanonicalStatus }
  | { op: "assign"; ticket: string; to: ActTarget | null }
  | { op: "comment"; on: { ticket: string } | { doc: string }; body: string }
  | { op: "set_parent"; ticket: string; parent: string };

/** Change the tracker as `as`, without a model run and without waking them. */
export interface Act {
  type: "act";
  policy: string;
  as: string;
  ops: ActOp[];
}

/** Nothing happens; recorded so it can be explained. */
export interface Drop {
  type: "drop";

  /** The policy that decided it, or none when no policy matched or a gate stopped the event. */
  policy?: string | undefined;
  reason: string;
}

export type Decision = Wake | Act | Drop;
