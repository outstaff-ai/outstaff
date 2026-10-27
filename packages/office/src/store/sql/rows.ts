import type { Selectable } from "kysely";
import type { Database } from "#/store/schema.js";
import type { Conversation, Link, Run, WorkItem } from "#/store/types.js";

export const toItem = (r: Selectable<Database["work_items"]>): WorkItem => ({
  id: r.id,
  person: r.person,
  kind: r.kind,
  priority: Number(r.priority),
  status: r.status,
  parentId: r.parent_id,
  subject:
    r.subject_type !== null && r.subject_ref !== null
      ? { type: r.subject_type, ref: r.subject_ref }
      : null,
  title: r.title,
  sessionId: r.session_id,
  workspace: r.workspace,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  trigger: r.trigger,
  attempts: Number(r.attempts),
  position: Number(r.position),
  failures: Number(r.failures),
  notBefore: r.not_before,
});

export const toRun = (r: Selectable<Database["runs"]>): Run => ({
  id: r.id,
  workItemId: r.work_item_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  error: r.error,
  usage: r.usage === null ? null : (JSON.parse(r.usage) as unknown),
});

export const toLink = (r: Selectable<Database["links"]>): Link => ({
  id: r.id,
  from: { type: r.from_type, ref: r.from_ref },
  to: { type: r.to_type, ref: r.to_ref },
  relation: r.relation,
  createdAt: r.created_at,
});

export const toConversation = (r: Selectable<Database["conversations"]>): Conversation => ({
  id: r.id,
  askerItemId: r.asker_item_id,
  target: r.target,
  question: r.question,
  answer: r.answer,
  status: r.status,
  depth: Number(r.depth),
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  deliveredAt: r.delivered_at,
});
