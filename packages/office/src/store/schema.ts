import type { Kysely } from "kysely";

// Timestamps are ISO-8601 UTC text with milliseconds; JSON columns are text.
// Both sort correctly as plain strings on either database.

export type WorkItemStatus = "queued" | "active" | "waiting" | "done" | "blocked" | "canceled";
export type WorkItemTrigger = "human" | "agent" | "automation" | "schedule";
export type ConversationStatus = "open" | "answered";

export interface CursorsTable {
  source: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface EventsTable {
  id: string;
  source: string;
  external_id: string;
  type: string;
  payload: string;
  received_at: string;
}

export interface WorkItemsTable {
  id: string;
  person: string;
  kind: string;
  priority: number;
  status: WorkItemStatus;
  parent_id: string | null;
  subject_type: string | null;
  subject_ref: string | null;
  title: string;
  session_id: string | null;
  workspace: string | null;
  created_at: string;
  updated_at: string;
  trigger: WorkItemTrigger;
  attempts: number;
}

export interface RunsTable {
  id: string;
  work_item_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
  usage: string | null;
}

export interface JournalTable {
  id: string;
  work_item_id: string;
  at: string;
  author: string;
  text: string;
}

export interface LinksTable {
  id: string;
  from_type: string;
  from_ref: string;
  to_type: string;
  to_ref: string;
  relation: string;
}

export interface SubjectsTable {
  type: string;
  ref: string;
  data: string;
  updated_at: string;
}

export interface LoopGuardTable {
  work_item_id: string;
  at: string;
}

export interface ConversationsTable {
  id: string;
  asker_item_id: string;
  target: string;
  question: string;
  answer: string | null;
  status: ConversationStatus;
  depth: number;
  created_at: string;
  answered_at: string | null;
}

export interface Database {
  cursors: CursorsTable;
  events: EventsTable;
  work_items: WorkItemsTable;
  runs: RunsTable;
  journal: JournalTable;
  links: LinksTable;
  subjects: SubjectsTable;
  loop_guard: LoopGuardTable;
  conversations: ConversationsTable;
}

export type Db = Kysely<Database>;
