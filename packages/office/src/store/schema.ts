import type { Generated, Kysely } from "kysely";

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
  processed_at: string | null;
  attempts: Generated<number>;
  process_error: string | null;
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
  position: number;
  failures: Generated<number>;
  not_before: string | null;
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
  delivered_at: string | null;
}

export interface PausesTable {
  scope: string;
  reason: string | null;
  paused_at: string;
}

export interface PipelineTracesTable {
  ref: string;
  type: string;
  at: string;
  data: string;
  recorded_at: string;
}

export interface DoctorChecksTable {
  scope: string;
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
  key: string | null;
  adapter: string | null;
  first_seen: string;
  last_seen: string;
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
  pauses: PausesTable;
  pipeline_traces: PipelineTracesTable;
  doctor_checks: DoctorChecksTable;
}

export type Db = Kysely<Database>;
