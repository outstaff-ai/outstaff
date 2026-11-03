import type { StoredEvent } from "./types.js";

/** A ticket, pull request, document or chat thread, by the office's key (as work item references name them). */
export interface MomentRef {
  type: string;
  ref: string;
}

/** One moment of an agent's history: something it did, was told, or saw happen on its work. */
export interface NewMoment {
  /** Unique per moment, so recording it again changes nothing: `item:<id>`, `journal:<id>`, `event:<event id>`. */
  key: string;

  /** The agent it belongs to; null for an event about a ticket, pull request or document, seen by every agent whose work refers to it. */
  person: string | null;

  /** When it happened (ISO-8601). */
  at: string;

  /** `item`, `journal`, `outcome`, or the event type (`ticket.commented`, `chat.message`, ...). */
  kind: string;

  /** Where it happened. */
  subject: MomentRef | null;
  workItemId?: string | null | undefined;

  /** Who: an id as its integration names them, a handle, `office` or `scheduler`. */
  actor?: string | null | undefined;

  /** Their display name, when the integration gave one. */
  actorName?: string | null | undefined;

  /** What was said or done. Data from whoever wrote it. */
  text: string;

  /** A link to the moment itself, such as a comment's, when the event carried one. */
  url?: string | null | undefined;
}

export interface Moment {
  key: string;
  person: string | null;
  at: string;
  kind: string;
  subject: MomentRef | null;
  workItemId: string | null;
  actor: string | null;
  actorName: string | null;
  text: string;
  url: string | null;
}

export interface MomentQuery {
  /** Whose history: the agent's own moments, and the events about what its work items refer to. */
  person: string;

  /** Full-text query: words (all must match, in any form), "quoted phrases", and -word to exclude. */
  text: string;

  /** Only moments by one of these actors, ids or names, compared case-insensitively. */
  with?: string[] | undefined;

  /**
   * Only moments about one of these: where they happened, or the work item they belong to (or, for an event or chat
   * message, a work item of the person on the same ticket, pull request, document or thread) refers to it.
   */
  about?: MomentRef[] | undefined;

  /** Only moments at or after this time (ISO-8601). */
  since?: string | undefined;

  /** Only moments before this time (ISO-8601): the cursor of the next page. */
  before?: string | undefined;

  limit: number;
}

export interface RecallStore {
  /** Records a moment; recording one with the same key again changes nothing. */
  recordMoment(moment: NewMoment): Promise<void>;

  /** The person's moments that match, newest first. */
  searchMoments(query: MomentQuery): Promise<Moment[]>;

  /**
   * Recorded events received after `after` (exclusive; from the first without it), oldest first: at most `limit`, and
   * then every other event received at the same time as the last one, so a time cursor never skips one.
   */
  listEventsAfter(query: { after?: string | undefined; limit: number }): Promise<StoredEvent[]>;
}
