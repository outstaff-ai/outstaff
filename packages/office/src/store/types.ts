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
  parentId?: string;
  subject?: { type: string; ref: string };
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
}

export interface WorkItemPatch {
  status?: WorkItemStatus;
  title?: string;
  priority?: number;
  sessionId?: string | null;
  workspace?: string | null;
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
}

export interface NewConversation {
  askerItemId: string;
  target: string;
  question: string;
  depth?: number;
}

export interface Store {
  readonly dialect: "postgres" | "sqlite";

  getCursor(source: string, key: string): Promise<string | undefined>;
  setCursor(source: string, key: string, value: string): Promise<void>;

  /** Returns false when (source, externalId) was already recorded. */
  recordEvent(event: NewEvent): Promise<boolean>;

  enqueue(input: NewWorkItem): Promise<WorkItem>;

  /**
   * Atomically takes the next queued item for a person (lowest priority number,
   * then oldest), marks it active, counts the attempt, and returns it.
   */
  dequeueNext(person: string): Promise<WorkItem | undefined>;
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

  createConversation(input: NewConversation): Promise<Conversation>;

  /** Throws if the conversation is unknown or already answered. */
  answerConversation(id: string, answer: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | undefined>;

  close(): Promise<void>;
}
