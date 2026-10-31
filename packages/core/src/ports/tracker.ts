import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { CanonicalStatus, RepoRef } from "./types.js";

export interface Member {
  id: string;
  name: string;
  username?: string;
  kind: "human" | "agent";
}

export interface Issue {
  key: string;
  id: string;
  title: string;
  body: string;
  status: { name: string; canonical?: CanonicalStatus };
  assignee?: Member;
  labels: string[];
  url: string;
  updatedAt: string;

  /** The tracker's priority, when it has one: 1 is the most urgent, and a larger number is less urgent. */
  priority?: number;
}

export interface Comment {
  id: string;
  author: Member;
  body: string;
  url: string;
  at: string;
}

export interface TrackerEvent {
  externalId: string;
  type: "created" | "assigned" | "moved" | "commented";
  key: string;
  actor: Member;
  at: string;

  /** A `commented` event carries `body`, `commentId`, `url` and `mentions`: the `@name`s in the body, as the adapter parsed them. */
  data: Record<string, unknown>;
}

export interface NewIssue {
  title: string;
  body: string;
  status?: CanonicalStatus;
  assignee?: string;
  labels?: string[];

  /** Key of the ticket this one is a subtask of. Only for a tracker with `setParent`; others ignore it. */
  parent?: string;
}

/** A file attached to a ticket, as the tracker lists it. */
export interface TicketAttachment {
  id: string;
  name: string;
  mimetype: string;

  /** Size in bytes; 0 when the tracker does not say. */
  size: number;
}

/** A file to attach to a ticket. */
export interface NewAttachment {
  name: string;
  mimetype: string;
  data: Uint8Array;
}

/** A pull request to show on a ticket. */
export interface PullRequestToLink {
  repo: { owner: string; name: string; host?: string | undefined };
  number: number;

  /** Its page on the code host, when known. */
  url?: string | undefined;
}

/**
 * What linking a pull request to a ticket did: linked it now, found it linked already, or could not, because the
 * pull request's repository is not connected to the tracker.
 */
export type PullRequestLinkOutcome = "linked" | "already_linked" | "not_connected";

export interface Tracker {
  links: Pick<Links, "issue" | "comment">;

  /**
   * True when an `@name` in a comment mentions (and notifies) a user of the tracker. Agents' comments are then
   * guarded the way pull request text is. Absent or false: `@` is plain text.
   */
  mentionsUsers?: boolean;
  getIssue(key: string): Promise<Issue>;
  listIssues(filter: {
    assignee?: string;
    status?: CanonicalStatus;
    updatedSince?: string;
    limit?: number;
  }): Promise<Issue[]>;
  search(query: string, limit?: number): Promise<Issue[]>;
  createIssue(issue: NewIssue): Promise<Issue>;

  /** Status names come from `team.workflow.statuses` via a `StatusMap` the adapter builds at create. */
  transition(key: string, to: CanonicalStatus): Promise<Issue>;
  assign(key: string, memberId: string | null): Promise<Issue>;
  comment(key: string, body: string): Promise<{ id: string; url: string }>;
  listComments(key: string): Promise<Comment[]>;
  setLabels(key: string, add: string[], remove: string[]): Promise<Issue>;
  link(key: string, otherKey: string, relation: "blocks" | "relates" | "duplicates"): Promise<void>;
  members(): Promise<Member[]>;

  /**
   * Capability `tracker.parents`: the tracker has a real parent (subtask) field. Makes `parentKey` the parent of
   * `key`; `createIssue` takes the same through `parent`. Absent when the tracker has none: callers then fall back to
   * a "relates" link. Throws `unsupported` when the tracker did not take the parent.
   */
  setParent?(key: string, parentKey: string): Promise<Issue>;

  /** Capability `tracker.attachments`. Adds a file to the ticket. */
  attach?(key: string, file: NewAttachment): Promise<void>;

  /** Capability `tracker.attachments`. The files attached to the ticket, by whoever attached them. */
  attachments?(key: string): Promise<TicketAttachment[]>;

  /** Capability `tracker.attachments`. The bytes of a file `attachments` listed. */
  download?(attachment: TicketAttachment): Promise<Uint8Array>;

  /**
   * Capability `tracker.development`. Shows the pull request on the ticket (its "Development" section), once: a pull
   * request already linked is left as it is. Only a repository connected to the tracker can be linked; for any other,
   * the outcome is `not_connected` and nothing changes.
   */
  linkPullRequest?(key: string, pr: PullRequestToLink): Promise<PullRequestLinkOutcome>;

  /** Capability `tracker.development`. The code repositories connected to the tracker, whose pull requests it can link. */
  connectedRepositories?(): Promise<RepoRef[]>;
  events(cursor?: string): Promise<EventPage<TrackerEvent>>;

  /** Webhook mode; same contract as `Vcs.parseWebhook`. */
  parseWebhook?(headers: Record<string, string | undefined>, body: string): Promise<TrackerEvent[]>;
}
