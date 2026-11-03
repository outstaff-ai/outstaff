import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { CanonicalStatus, RepoRef } from "./types.js";

export interface Member {
  id: string;
  name: string;
  username?: string;
  kind: "human" | "agent";
}

/** Another ticket a ticket is linked to as blocking or blocked, with that ticket's current status. */
export interface LinkedIssue {
  key: string;
  status: { name: string; canonical?: CanonicalStatus };
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

  /** The tickets this one blocks (its `blocks` links). Absent when the tracker did not say, as in a listing. */
  blocks?: LinkedIssue[];

  /** The tickets that block this one. Absent when the tracker did not say, as in a listing. */
  blockedBy?: LinkedIssue[];

  /** Key of the ticket this one is a subtask of. Absent when it has none or the tracker did not say, as in a listing. */
  parent?: string;
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

/** What `updateIssue` changes; a field left out stays as it is. */
export interface IssueChanges {
  title?: string;
  body?: string;
}

/** Which tickets `listIssues` returns. Every filter given must match; none given lists all. */
export interface IssueFilter {
  /** Id of the tracker member they are assigned to; `null` for tickets assigned to nobody. */
  assignee?: string | null;

  /** In any of these canonical statuses. */
  status?: CanonicalStatus[];

  /** Carrying this label, by name. A label the tracker does not have matches nothing. */
  label?: string;

  /** Subtasks of this ticket, by key. */
  parent?: string;

  /** Updated at or after this time (ISO-8601). */
  updatedSince?: string;

  /** At most this many. */
  limit?: number;

  /**
   * Only what a listing shows: key, title, status, assignee, labels, URL and update time. The body is then empty, and
   * blocks, blockedBy and parent are absent. A tracker whose listing carries more may return more.
   */
  brief?: boolean;
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

/** How one ticket relates to another, read from the first one's side. */
export type LinkRelation = "blocks" | "relates" | "duplicates";

/** A project-wide custom field of the tracker. Only numbers so far. */
export interface TrackerField {
  name: string;
  type: "number";
}

/** What making sure a field exists did: created it now, or found it there already. */
export type FieldEnsureOutcome = "created" | "exists";

export interface Tracker {
  links: Pick<Links, "issue" | "comment">;

  /**
   * True when an `@name` in a comment mentions (and notifies) a user of the tracker. Agents' comments are then
   * guarded the way pull request text is. Absent or false: `@` is plain text.
   */
  mentionsUsers?: boolean;
  getIssue(key: string): Promise<Issue>;

  /** The tickets every given filter matches, most recently updated first. */
  listIssues(filter: IssueFilter): Promise<Issue[]>;
  search(query: string, limit?: number): Promise<Issue[]>;
  createIssue(issue: NewIssue): Promise<Issue>;

  /** Changes the title or description of an issue; a field left out stays as it is. */
  updateIssue(key: string, changes: IssueChanges): Promise<Issue>;

  /** Status names come from `team.workflow.statuses` via a `StatusMap` the adapter builds at create. */
  transition(key: string, to: CanonicalStatus): Promise<Issue>;
  assign(key: string, memberId: string | null): Promise<Issue>;
  comment(key: string, body: string): Promise<{ id: string; url: string }>;
  listComments(key: string): Promise<Comment[]>;
  setLabels(key: string, add: string[], remove: string[]): Promise<Issue>;

  /** Links two tickets, the relation read from `key`'s side: `key` blocks, relates to or duplicates `otherKey`. */
  link(key: string, otherKey: string, relation: LinkRelation): Promise<void>;

  /**
   * Removes the link `link` makes with the same arguments; a "relates" link either way round. Unlinking tickets that
   * are not linked so changes nothing. An unknown key is `not_found`.
   */
  unlink(key: string, otherKey: string, relation: LinkRelation): Promise<void>;
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

  /**
   * Capability `tracker.fields`. Makes sure the project has a custom field of this name (exact, case-insensitive) and
   * type, creating it when missing. A field of that name with another type is a `conflict`.
   */
  ensureField?(field: TrackerField): Promise<FieldEnsureOutcome>;

  /** Capability `tracker.fields`. Whether the project has a custom field of this name and type. */
  hasField?(field: TrackerField): Promise<boolean>;

  /** Capability `tracker.fields`. Sets a number field of the ticket, by the field's name; `null` clears it. A missing field is `not_found`. */
  setField?(key: string, field: string, value: number | null): Promise<void>;

  /** Capability `tracker.fields`. The value of a number field of the ticket; null when it has none. */
  fieldValue?(key: string, field: string): Promise<number | null>;
  events(cursor?: string): Promise<EventPage<TrackerEvent>>;

  /** Webhook mode; same contract as `Vcs.parseWebhook`. */
  parseWebhook?(headers: Record<string, string | undefined>, body: string): Promise<TrackerEvent[]>;
}
