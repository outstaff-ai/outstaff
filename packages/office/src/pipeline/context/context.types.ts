import type { ContextWhy } from "@outstaff/protocol";
import type { CiState } from "#/workstate/index.js";
import type { ItemRef } from "#/store/types.js";

/** How much of what the office knows goes with one wake (`pipeline.context`). */
export interface ContextLimits {
  comments: number;
  messages: number;
  threads: number;
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
}

/** A linked item of the bundle, before it is filled in. */
export type ContextNode = Pick<ManifestEntry, "type" | "ref" | "url" | "why">;

/** What went into one wake's bundle, recorded in the trace of the event that woke the item. */
export interface ContextManifest {
  itemId: string;
  entries: ManifestEntry[];
  omitted: number;
  limits: ContextLimits;
}
