import { SILENT_KINDS } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";
import type { ItemRun } from "./work.types.js";

/**
 * Statuses a ticket the agent moved to in the round that leave something to review or finished: closed, canceled, or
 * moved to review on purpose, with an answer that needs a human's review.
 */
const HANDED_ON = new Set(["done", "canceled", "review"]);

/** The pull requests of the item open for review (not drafts), as the office saw them when it offered the item. */
const openForReview = (offer: Offer) =>
  offer.context.subjects
    .filter((s) => s.type === "pr" && s.state === "open" && s.draft !== true)
    .map((s) => `pull request ${s.ref} is open for review`);

/** The tickets the agent closed, canceled or moved to review in this run. */
const handedOnTickets = (moved: Map<string, string>) =>
  [...moved].filter(([, to]) => HANDED_ON.has(to)).map(([key, to]) => `moved ${key} to ${to}`);

/**
 * What a `done` hand-back leaves to review or finished, whatever the item's kind: the agent opened, updated or merged
 * a pull request or linked a document in this run, closed or canceled a ticket or moved it to review, or a pull
 * request of the item is open for review. Empty means `done` is refused.
 */
export function toReview({ offer, item }: ItemRun): string[] {
  return [...item.produced(), ...handedOnTickets(item.moved), ...openForReview(offer)];
}

/**
 * Whether a round with nothing to review finishes silently, leaving the ticket as it is: the agent said `silent`, or
 * the round is of a kind that may (a comment, a mention, a question, chat, a review, a merge, pull request upkeep) and
 * the agent did not say `done`. Work on a ticket said `silent` only while it waits on work in flight; the office checks.
 */
export const finishesSilently = ({ offer, item }: ItemRun) =>
  item.declared() === "silent" ||
  (SILENT_KINDS.includes(offer.workItem.kind) && item.declared() !== "done");

/** The first line of the prompt that refuses a `done` hand-back; the rest says what to do instead. */
export const NOTHING_TO_REVIEW = "Nothing to review: this round cannot be handed back as done.";

/** Sent in the item's session once, when the round would be handed back as done with nothing to review. */
export const NOTHING_TO_REVIEW_PROMPT = [
  NOTHING_TO_REVIEW,
  "",
  "No pull request of this item is open for review, none was opened, updated or merged in this round, no document was linked, and no ticket was closed or moved to review. `done` is only for a result to review or finished work.",
  "",
  "- If you need a decision or an answer from a human, or anything outside your control: comment where the work came from (the ticket, or the chat thread) with what you need and from whom, and end the round. It is handed back as `blocked` (`ost handback blocked`).",
  "- If you wait for another agent's answer, ask it with `ost ask`; the item then waits for it.",
  "- If you did make a result, open or link it now: `ost pr open`, `ost pr update --ready`, `ost doc create`. An answer that needs a human's review: comment it on the ticket and move the ticket to review (`ost ticket move <key> review`).",
  "- If the work needed nothing from you (a comment or mention that asks nothing of you), or you wait on a human's review of a pull request or on sub-tickets someone else holds, say `ost handback silent`: the ticket is put back as the round found it. Waiting on a review is not blocked.",
  "",
  "End with one line that says where the work is and what is needed.",
].join("\n");
