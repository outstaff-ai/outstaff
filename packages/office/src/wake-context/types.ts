import type { Logger, Tracker, Vcs } from "@outstaff/core";
import type { ContextLimits } from "#/pipeline/context/index.js";
import type { TraceStore } from "#/pipeline/trace.types.js";
import type { Store } from "#/store/types.js";

/** What the office reads to hand over a wake's context. The ports are read with the office's own credentials. */
export interface ContextReaders {
  store: Store;
  tracker?: Pick<Tracker, "getIssue" | "listComments"> | undefined;
  vcs?: Pick<Vcs, "reviewThreads" | "links"> | undefined;
}

/** The references the walk found around an item, before their data is read. */
export interface Neighbourhood {
  tickets: Set<string>;
  prs: Set<string>;
  docs: Set<string>;
  chats: Set<string>;
  related: { via: { type: "ticket" | "pr"; ref: string }; chat: string; itemId: string }[];
}

/** How the office hands each wake its context. */
export interface WakeContextOptions {
  limits: ContextLimits;

  /** Where the event that woke an item was traced; what its bundle carried is added there. */
  traces?: Pick<TraceStore, "get" | "record"> | undefined;
  logger?: Pick<Logger, "warn"> | undefined;
}
