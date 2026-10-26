import type { ConversationStatus, WorkItemStatus, WorkItemTrigger } from "./schema.js";

export type { ConversationStatus, WorkItemStatus, WorkItemTrigger };

export interface NewEvent {
  source: string;
  externalId: string;
  type: string;
  payload: unknown;
}

export interface NewWorkItem {
  person: string;
  kind: string;
  title: string;
  trigger: WorkItemTrigger;

  /** Lower runs first. Default 100. */
  priority?: number;

  /** Order within a priority class, lower first. Default: after every queued item of the person. */
  position?: number;
  parentId?: string;
  subject?: { type: string; ref: string };
}

export interface StoredEvent extends NewEvent {
  id: string;
  receivedAt: string;

  /** Failed delivery attempts so far. */
  attempts: number;
}

export interface WorkItem {
  id: string;
  person: string;
  kind: string;
  priority: number;
  status: WorkItemStatus;
  parentId: string | null;
  subject: { type: string; ref: string } | null;
  title: string;
  sessionId: string | null;
  workspace: string | null;
  createdAt: string;
  updatedAt: string;
  trigger: WorkItemTrigger;
  attempts: number;
  position: number;

  /** Consecutive failed runs; a successful hand-back resets it. */
  failures: number;

  /** The item is not offered before this time (ISO-8601), or null. */
  notBefore: string | null;
}

export interface WorkItemPatch {
  status?: WorkItemStatus;
  title?: string;
  priority?: number;
  position?: number;
  failures?: number;
  notBefore?: string | null;
  sessionId?: string | null;
  workspace?: string | null;
  subject?: { type: string; ref: string };
}

export interface Run {
  id: string;
  workItemId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  error: string | null;
  usage: unknown;
}

export interface JournalEntry {
  id: string;
  workItemId: string;
  at: string;
  author: string;
  text: string;
}

export interface Ref {
  type: string;
  ref: string;
}

export interface Link {
  id: string;
  from: Ref;
  to: Ref;
  relation: string;
}

export interface LinkQuery {
  from?: Ref;
  to?: Ref;
  relation?: string;
}

export interface Subject {
  type: string;
  ref: string;
  data: unknown;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  askerItemId: string;
  target: string;
  question: string;
  answer: string | null;
  status: ConversationStatus;
  depth: number;
  createdAt: string;
  answeredAt: string | null;

  /** When the answer was handed to the asker's work item; null while it waits for the asker to stop running. */
  deliveredAt: string | null;
}

export interface NewConversation {
  askerItemId: string;
  target: string;
  question: string;
  depth?: number;
}

export interface QueueOrderEntry {
  id: string;
  priority: number;
  position: number;
}

export interface Pause {
  /** Opaque key chosen by the caller, for example "team" or "person:ann". */
  scope: string;
  reason: string | null;
  pausedAt: string;
}

/** What the event pipeline decided for one event, and why. `data` is the pipeline's trace, stored as JSON. */
export interface NewTrace {
  /** The event's `<source>:<externalId>`. */
  ref: string;
  type: string;

  /** When the event happened (ISO-8601); traces are listed by it. */
  at: string;
  data: unknown;
}

export interface StoredTrace extends NewTrace {
  recordedAt: string;
}

export interface TraceQuery {
  /** Only traces of events before this time (ISO-8601): the cursor for the next page. */
  before?: string;

  /** Default 50. */
  limit?: number;
}

export interface Store {
  readonly dialect: "postgres" | "sqlite";

  getCursor(source: string, key: string): Promise<string | undefined>;
  setCursor(source: string, key: string, value: string): Promise<void>;

  /** Returns false when (source, externalId) was already recorded. */
  recordEvent(event: NewEvent): Promise<boolean>;

  /** Events recorded but not yet marked processed, oldest first. */
  listUnprocessed(limit?: number): Promise<StoredEvent[]>;

  /** Counts a failed delivery and returns the new total. */
  noteEventAttempt(source: string, externalId: string): Promise<number>;

  /** Marks delivery done; `error` records why delivery was given up. Idempotent. */
  markProcessed(source: string, externalId: string, error?: string): Promise<void>;

  enqueue(input: NewWorkItem): Promise<WorkItem>;

  /**
   * Atomically takes the next queued item for a person (lowest priority number,
   * then oldest), marks it active, counts the attempt, and returns it.
   */
  dequeueNext(person: string): Promise<WorkItem | undefined>;

  /** Atomically moves one queued item to active and counts the attempt; undefined if it is not queued. */
  activateItem(id: string): Promise<WorkItem | undefined>;

  /** Rewrites priority and position of queued items in one transaction. Throws on an unknown item. */
  reorderQueue(entries: QueueOrderEntry[]): Promise<void>;
  getItem(id: string): Promise<WorkItem | undefined>;
  listItems(filter?: { person?: string; status?: WorkItemStatus }): Promise<WorkItem[]>;
  updateItem(id: string, patch: WorkItemPatch): Promise<WorkItem>;

  startRun(workItemId: string): Promise<Run>;
  finishRun(
    id: string,
    result: { outcome: string; error?: string; usage?: unknown },
  ): Promise<void>;
  listRuns(workItemId: string): Promise<Run[]>;

  appendJournal(workItemId: string, author: string, text: string): Promise<JournalEntry>;
  readJournal(workItemId: string): Promise<JournalEntry[]>;

  upsertSubject(type: string, ref: string, data: unknown): Promise<void>;
  getSubject(type: string, ref: string): Promise<Subject | undefined>;

  /** Idempotent: linking an existing edge returns it. */
  link(from: Ref, to: Ref, relation: string): Promise<Link>;

  /** Returns the number of edges removed. */
  unlink(from: Ref, to: Ref, relation: string): Promise<number>;
  queryLinks(query: LinkQuery): Promise<Link[]>;

  recordLoopGuard(workItemId: string): Promise<void>;

  /** Number of guarded runs of the item in the last `windowMs`. */
  countLoopGuard(workItemId: string, windowMs: number): Promise<number>;

  /** Forgets the item's latest guarded run: a run cut short by a shutdown is no loop. */
  forgetLatestLoopGuard(workItemId: string): Promise<void>;

  /** Forgets the item's guarded runs, so a human's retry starts with a clean count. */
  clearLoopGuard(workItemId: string): Promise<void>;

  /** Idempotent: pausing a paused scope keeps the first pause. */
  setPause(scope: string, reason?: string): Promise<void>;

  /** Returns whether the scope was paused. */
  clearPause(scope: string): Promise<boolean>;
  listPauses(): Promise<Pause[]>;

  createConversation(input: NewConversation): Promise<Conversation>;

  /** Throws if the conversation is unknown or already answered. */
  answerConversation(id: string, answer: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;

  /** Answered conversations of an asker item whose answer was not delivered yet, oldest first. */
  listUndelivered(askerItemId: string): Promise<Conversation[]>;

  /** Idempotent. */
  markDelivered(id: string): Promise<void>;

  /** Records the trace of an event; a second trace of the same event replaces the first. */
  recordTrace(trace: NewTrace): Promise<void>;
  getTrace(ref: string): Promise<StoredTrace | undefined>;

  /** Newest event first. */
  listTraces(query?: TraceQuery): Promise<StoredTrace[]>;

  /** In the order they were recorded (then by ref), from `from` on, inclusive: for shipping traces out in order. */
  listTracesRecorded(query: { from?: string | undefined; limit: number }): Promise<StoredTrace[]>;

  close(): Promise<void>;
}

export interface OpenStoreOptions {
  /** Run pending migrations on open. Default true. */
  migrate?: boolean;

  /** Postgres only: keep tables in this schema (created if missing). */
  schema?: string;

  /** Clock override, for tests. */
  now?: () => Date;
}
