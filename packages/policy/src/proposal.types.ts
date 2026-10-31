import type { ActOp } from "@outstaff/core";

/** What a woken agent's run is about; the key wakes are merged by, together with the person. */
export interface WakeSubject {
  type: "pr" | "ticket" | "doc" | "chat";

  /** `owner/name#n` for a pull request, the key of a ticket, the id of a document, `channel:thread` (or the channel, for a direct message's top-level messages) for chat. */
  ref: string;
}

/** Wake an agent: it runs with the instruction and decides how. Its feedback is the event's. */
export interface WakeProposal {
  type: "wake";
  person: string;
  kind: string;
  instruction: string;

  /** What the run is about; the event's subject when not given. */
  subject?: WakeSubject | undefined;
  reason: string;
}

/** The changes an act may make: bookkeeping only. Anything that needs judgement is a wake. */
export type BookkeepingOp = Extract<ActOp, { op: "move" | "assign" | "set_parent" | "link_pr" }>;

/** Change the tracker for an agent, without a model run; `note` is posted with the changes, in the agent's voice. */
export interface ActProposal {
  type: "act";

  /** The agent the changes are made for. */
  as: string;
  ops: BookkeepingOp[];
  note?: string | undefined;
  reason: string;
}

/** Nothing happens; recorded so it can be explained. */
export interface DropProposal {
  type: "drop";
  reason: string;
}

/**
 * Keeps another policy's wake of the person from happening, for example because the event is the agent's own reply.
 * Narrowed by subject and kind when given. A suppression beats a wake whatever the priorities.
 */
export interface SuppressProposal {
  type: "suppress";
  person: string;
  subject?: WakeSubject | undefined;
  kind?: string | undefined;
  reason: string;
}

export type Proposal = WakeProposal | ActProposal | DropProposal | SuppressProposal;

/** In a trace only: the policy threw or returned something that is not a proposal. */
export interface ErrorProposal {
  type: "error";
  reason: string;
}
