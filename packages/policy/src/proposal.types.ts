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
export type BookkeepingOp = Extract<
  ActOp,
  { op: "move" | "assign" | "set_parent" | "link_pr" | "link_doc" }
>;

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

/**
 * Stops the work on a ticket nobody wants any more: every agent's queued work on it, and on its pull requests, is
 * canceled, and an agent running such work is sent `notice` as a round of its own, which starts when the running one
 * ends. The agents in `except` are left alone, for example the agent who closed its own ticket.
 */
export interface StopProposal {
  type: "stop";
  ticket: string;

  /** What the agent running work on the ticket is told, and the line the canceled items' journals get. */
  notice: string;
  except?: string[] | undefined;
  reason: string;
}

/** A pull request a notice points the human to. */
export interface NoticePr {
  /** `owner/name#n`. */
  ref: string;
  url?: string | undefined;
  title?: string | undefined;

  /** The head commit whose checks passed, which the office sets on a review notice it held until they finished. */
  head?: string | undefined;
}

/**
 * What a notice about a ticket put in front of the human: who, and the head commit of each of its pull requests open
 * for review, by `owner/name#n`. The office keeps the last one per ticket and hands it to the next hand-back as
 * `data.notified`, so a round that leaves the same heads with the same human tells them nothing new.
 */
export interface NoticeSeen {
  human: string;
  prs: Record<string, string>;
}

/**
 * Tell a human in chat that work landed on them: a direct message from the agent's own chat account. The office
 * holds a human's notices from one agent for a short while, and while that agent's round on the ticket still runs,
 * then sends them as one message.
 */
export interface NotifyProposal {
  type: "notify";

  /** The agent who sends the message. */
  as: string;

  /** The human, by an identity the team file gives them: tracker, vcs, or their name. */
  human: string;

  /** What is needed from them: a review, or what blocks the work. */
  need: "review" | "blocked";
  ticket?: string | undefined;
  prs?: NoticePr[] | undefined;

  /** What is needed, in the agent's words (the hand-back summary); the message keeps its first lines. */
  text?: string | undefined;

  /**
   * The human was told already, in the chat thread the work came from: nothing is sent, and the notices held for the
   * ticket are dropped.
   */
  told?: boolean | undefined;

  /** What the notice puts in front of the human, for the office to remember for the ticket. */
  seen?: NoticeSeen | undefined;
  reason: string;
}

export type Proposal =
  | WakeProposal
  | ActProposal
  | DropProposal
  | SuppressProposal
  | StopProposal
  | NotifyProposal;

/** In a trace only: the policy threw or returned something that is not a proposal. */
export interface ErrorProposal {
  type: "error";
  reason: string;
}
