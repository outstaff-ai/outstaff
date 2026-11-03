import type { EventPage } from "./events.js";
import type { Links } from "./links.js";
import type { Member } from "./tracker.js";

export interface Doc {
  id: string;
  path: string;
  title: string;
  body: string;
  url: string;

  /** Opaque; pass back as `baseVersion` to detect concurrent edits. */
  version: string;
  updatedAt: string;
}

export interface DocComment {
  id: string;
  docId: string;
  author: string;
  body: string;
  anchorText?: string;
  parentId?: string;
  resolved: boolean;
  at: string;
}

/** A comment or reply written on a document; the event feed of a knowledge base. */
export interface DocEvent {
  /** Stable across polls: the office de-duplicates by it. */
  externalId: string;
  type: "commented";

  /** Id of the document. */
  doc: string;
  title: string;
  url: string;
  actor: Member;
  at: string;
  data: {
    commentId: string;
    parentId?: string;

    /** The text of the document the comment is anchored to. */
    anchorText?: string;
    body: string;

    /** The `@name` mentions in the body, as the adapter parsed them; the office maps them to team members. */
    mentions?: string[];
  };
}

/** A document linked on a ticket, as the knowledge base lists the ticket's documents. */
export interface IssueDoc {
  id: string;
  title: string;
}

/** What linking a document on a ticket did: linked it now, or found it linked already. */
export type DocIssueLinkOutcome = "linked" | "already_linked";

/** Whose notes are read or written: the calling agent, and whose versions of them count. */
export interface NotesOwner {
  /** The agent's name; the knowledge base may show the notes under it. */
  name: string;

  /** Whether a version written by `author` may be used: the agent itself or a trusted human. */
  trusted(author: Member): boolean;
}

/** A version of the notes that was not used, because `NotesOwner.trusted` refused its author. */
export interface IgnoredNotesEdit {
  author: Member;
  at: string;
  version: string;
}

/** The calling agent's notes as the knowledge base keeps them. */
export interface NotesPage {
  /** The notes of the newest version a trusted author wrote, in order; empty when there is none. */
  notes: string[];

  /** The current version, which a write must name; absent while the agent has no notes yet. */
  version?: string;

  /** The document that shows the notes, when there is one: comments on it reach the agent as document comments. */
  doc?: { id: string; title: string; url: string };

  /** A newer version than the one used, by an author who is not trusted; the newest such one. */
  ignored?: IgnoredNotesEdit;
}

/**
 * Capability `knowledge.notes`: an agent's notes, kept apart from the documents. The knowledge base stores and shows
 * them as it likes; it never decides whom to trust, the caller's `NotesOwner` does.
 */
export interface KnowledgeNotes {
  read(owner: NotesOwner): Promise<NotesPage>;

  /**
   * Replaces the notes. `version` is the one read: absent creates the notes, and a stale one, or notes created
   * meanwhile, is a `conflict`.
   */
  write(owner: NotesOwner, notes: string[], version: string | undefined): Promise<NotesPage>;
}

export interface Knowledge {
  links: Pick<Links, "doc" | "comment">;
  search(query: string, limit?: number): Promise<Doc[]>;
  get(idOrPath: string): Promise<Doc>;
  create(doc: { path: string; title: string; body: string }): Promise<Doc>;

  /** Rejects with `conflict` when `baseVersion` is stale. */
  update(id: string, patch: { title?: string; body?: string; baseVersion?: string }): Promise<Doc>;
  comments(id: string): Promise<DocComment[]>;
  comment(id: string, comment: { body: string; anchorText?: string }): Promise<DocComment>;
  reply(commentId: string, body: string): Promise<DocComment>;
  resolve(commentId: string): Promise<void>;

  /**
   * Comments and replies on the given documents, oldest first by the time they were written. Same contract as
   * `Tracker.events`: an opaque cursor in and out, a re-read of the recent past (the office de-duplicates by
   * `externalId`), and the first call without a cursor only says where "now" is. The caller names the documents,
   * so a feed that is not per document is still bounded.
   */
  events(docs: string[], cursor?: string): Promise<EventPage<DocEvent>>;

  /**
   * Capability `knowledge.issueLinks`. Shows the document on the ticket (by its key), once: a document already linked
   * is left as it is. An unknown document or ticket is `not_found`.
   */
  linkIssue?(docId: string, ticketKey: string): Promise<DocIssueLinkOutcome>;

  /** Capability `knowledge.issueLinks`. The documents linked on the ticket. */
  issueDocs?(ticketKey: string): Promise<IssueDoc[]>;

  /**
   * Capability `knowledge.issueLinks`, where the knowledge base shares the tracker's initiatives (`tracker.initiatives`).
   * Links the document to the initiative (a milestone), once. An unknown document or initiative is `not_found`.
   */
  linkInitiative?(docId: string, initiativeId: string): Promise<DocIssueLinkOutcome>;

  /** With `linkInitiative`: the documents linked to the initiative. */
  initiativeDocs?(initiativeId: string): Promise<IssueDoc[]>;

  /** Capability `knowledge.notes`. The calling agent's notes. */
  notes?: KnowledgeNotes;
}
