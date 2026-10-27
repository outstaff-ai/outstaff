/** What a work item refers to. */
export type ItemRefType =
  | "ticket"
  | "pr"
  | "doc"
  | "chat_thread"
  | "chat_message"
  | "branch"
  | "commit";

/**
 * How the reference came to the item: what started it (`trigger`), what it is about (`subject`), what its agent made
 * (`created`), what a request added to it (`attached`), what feedback named (`mentioned`), or what the work state
 * worked out (`inferred`: a pull request's ticket, the pull request a stack is based on).
 */
export type ItemRefRole = "trigger" | "subject" | "created" | "attached" | "mentioned" | "inferred";

export interface NewItemRef {
  type: ItemRefType;

  /** The office's key: a ticket key, the work state's pull request key, `<channel>:<thread>` for a chat thread. */
  ref: string;
  url?: string | undefined;
  role: ItemRefRole;

  /** What added it: the event id, the agent's verb, or the inference. */
  source: string;
}

export interface ItemRef extends NewItemRef {
  workItemId: string;

  /** When the office first learned of it (ISO-8601). */
  addedAt: string;
}

export interface ItemRefStore {
  /**
   * Records references of an item. Idempotent per item, type and ref: the first record keeps its role, source and
   * time, and only gains a url it did not have.
   */
  addItemRefs(workItemId: string, refs: NewItemRef[]): Promise<void>;

  /** One item's references, in the order they were added. */
  listItemRefs(workItemId: string): Promise<ItemRef[]>;

  /** Every item's record of one reference, oldest first. */
  findItemRefs(type: ItemRefType, ref: string): Promise<ItemRef[]>;
}
