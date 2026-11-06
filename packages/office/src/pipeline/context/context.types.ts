import type { ContextWhy } from "@outstaff/protocol";
import type { CiState } from "#/workstate/index.js";
import type { ItemRef } from "#/store/types.js";

/** How much of what the office knows goes with one wake (`pipeline.context`). */
export interface ContextLimits {
  comments: number;
  messages: number;
  threads: number;
  reviews: number;
  items: number;
  bodyChars: number;
}

export interface GraphNote {
  author: string;
  at: string;
  url?: string | undefined;
  body: string;
}

export interface GraphTicket {
  key: string;
  title: string;
  url?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  description?: string | undefined;

  /** Oldest first. */
  comments: GraphNote[];

  /** The key of the ticket it is a subtask of, when the tracker says. */
  parent?: string | undefined;

  /** The woken agent's work: assigned to it, or it was the last to work on it. */
  yours?: boolean | undefined;

  /** For the ticket being worked on: review comments on its and its parent's pull requests, in no order. */
  reviews?: GraphReview[] | undefined;
}

/** A review comment on a pull request of the ticket being worked on, or of its parent. */
export interface GraphReview {
  pr: string;
  ticket?: string | undefined;
  resolved: boolean;
  path?: string | undefined;
  line?: number | undefined;
  url?: string | undefined;
  author: string;
  at: string;
  body: string;
}

export interface GraphThread {
  path?: string | undefined;
  line?: number | undefined;
  url?: string | undefined;
  author: string;
  body: string;
}

export interface GraphPr {
  ref: string;
  number: number;
  title: string;
  url?: string | undefined;

  /** Who opened it: the agent's handle, else the code host login. */
  author: string;

  /** The woken agent's work: it opened it, or the ticket it implements is the agent's. */
  yours?: boolean | undefined;
  state: "open" | "closed" | "merged";
  draft: boolean;
  ci: CiState;
  checks: { name: string; status: string }[];
  mergeable: "clean" | "conflicting" | "unknown";
  review?: string | undefined;
  unresolvedThreads: number;

  /** The unresolved review threads, when the code host could be read. */
  threads: GraphThread[];
  ticket?: string | undefined;
  stackedOn?: string | undefined;

  /** When the code host answered the pull request as not found or forbidden; a gone one counts as not open. */
  goneAt?: string | undefined;
}

export interface GraphDoc {
  id: string;
  title: string;
  url?: string | undefined;
  ticket?: string | undefined;
}

export interface GraphChat {
  /** `<channel>:<thread>`. */
  key: string;
  channel: string;
  thread: string;

  /** Oldest first. */
  messages: { author: string; at: string; text: string }[];
}

/** A chat thread another item has, found through a ticket or pull request both refer to. */
export interface GraphRelatedChat {
  via: { type: "ticket" | "pr"; ref: string };
  chat: string;
  itemId: string;
}

/** What the office knows around one work item, read at one moment: the input of the context builder. */
export interface ContextGraph {
  itemId: string;

  /** The item's own references, in the order they were added. */
  refs: ItemRef[];
  tickets: GraphTicket[];
  prs: GraphPr[];
  docs: GraphDoc[];
  chats: GraphChat[];
  related: GraphRelatedChat[];
}

/** One linked item a bundle carries, for the trace: what it is, why, and how much of it went in. */
export interface ManifestEntry {
  type: "ticket" | "pr" | "doc" | "chat_thread";
  ref: string;
  url?: string | undefined;
  why: ContextWhy;

  /** Comments, review threads or messages that went in, and how many were left out. */
  shown?: number | undefined;
  left?: number | undefined;

  /** For the ticket being worked on: review comments that went in, and how many were left out. */
  reviews?: { shown: number; left: number } | undefined;
}

/** A linked item of the bundle, before it is filled in. */
export type ContextNode = Pick<ManifestEntry, "type" | "ref" | "url" | "why">;

/** What a merge's context named: the pull request, the base's checks, the other open pull requests, the merges. */
export interface MergeManifest {
  pr: string;
  base: { ref: string; ci: string };

  /** The other open pull requests it named, each with how it relates. */
  others: { ref: string; relation: string[] }[];
  moreOthers: number;
  recentMerges: string[];
}

/** What went into one wake's bundle, recorded in the trace of the event that woke the item. */
export interface ContextManifest {
  itemId: string;
  entries: ManifestEntry[];
  omitted: number;
  limits: ContextLimits;
  merge?: MergeManifest | undefined;
}
