import type { PortError } from "./errors.js";
import type { EventPage } from "./events.js";
import type { RepoRef } from "./types.js";

export interface VcsEvent {
  /** What intake de-duplicates on: a comment or a review has one id, however and however often it is read. */
  externalId: string;
  type:
    | "pr.opened"
    | "pr.merged"
    | "pr.closed"
    | "pr.review_submitted"
    | "pr.comment"
    | "pr.synchronize";
  repo: RepoRef;
  number: number;

  /** Login of whoever caused the event. */
  actor: string;
  at: string;
  data: Record<string, unknown>;
}

/** A repository an events poll could not read (`not_found` or `forbidden`); the others were read. */
export interface UnreadRepo {
  repo: RepoRef;
  error: PortError;
}

export interface VcsEventPage extends EventPage<VcsEvent> {
  /** The repositories that could not be read this poll; each keeps its place in the cursor. */
  unread?: UnreadRepo[];
}

/** What a reaction goes on: a comment of the pull request conversation or an inline comment of a review. */
export interface ReactionTarget {
  kind: "conversation_comment" | "inline_comment";

  /** The comment id the host reports, as in `ReviewInlineComment.id` and the `commentId` of `pr.comment` events. */
  id: string;
}

export type Reaction = "eyes";
