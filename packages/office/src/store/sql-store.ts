import { randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import type { Db, Database } from "./schema.js";
import type {
  Conversation,
  JournalEntry,
  Link,
  LinkQuery,
  NewConversation,
  NewEvent,
  NewWorkItem,
  Pause,
  QueueOrderEntry,
  Ref,
  Run,
  Store,
  Subject,
  WorkItem,
  WorkItemPatch,
  WorkItemStatus,
} from "./types.js";

export interface StoreInternals {
  db: Db;
  dialect: "postgres" | "sqlite";
  now: () => Date;
}

let lastMs = 0;
let counter = 0;

/** Time-ordered unique id: sorts by creation order within a process. */
export function newId(ms: number): string {
  if (ms === lastMs) {
    counter++;
  } else {
    lastMs = ms;
    counter = 0;
  }

  return `${ms.toString().padStart(13, "0")}${counter.toString().padStart(4, "0")}${randomBytes(4).toString("hex")}`;
}

const iso = (d: Date) => d.toISOString();

const toItem = (r: Selectable<Database["work_items"]>): WorkItem => ({
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

const toRun = (r: Selectable<Database["runs"]>): Run => ({
  id: r.id,
  workItemId: r.work_item_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome,
  error: r.error,
  usage: r.usage === null ? null : (JSON.parse(r.usage) as unknown),
});

const toLink = (r: Selectable<Database["links"]>): Link => ({
  id: r.id,
  from: { type: r.from_type, ref: r.from_ref },
  to: { type: r.to_type, ref: r.to_ref },
  relation: r.relation,
});

const toConversation = (r: Selectable<Database["conversations"]>): Conversation => ({
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

export function createSqlStore({ db, dialect, now }: StoreInternals): Store {
  const stamp = () => iso(now());

  const store: Store = {
    dialect,

    async getCursor(source, key) {
      const row = await db
        .selectFrom("cursors")
        .select("value")
        .where("source", "=", source)
        .where("key", "=", key)
        .executeTakeFirst();

      return row?.value;
    },

    async setCursor(source, key, value) {
      await db
        .insertInto("cursors")
        .values({ source, key, value, updated_at: stamp() })
        .onConflict((oc) =>
          oc.columns(["source", "key"]).doUpdateSet({ value, updated_at: stamp() }),
        )
        .execute();
    },

    async recordEvent(e: NewEvent) {
      const at = now();
      const res = await db
        .insertInto("events")
        .values({
          id: newId(at.getTime()),
          source: e.source,
          external_id: e.externalId,
          type: e.type,
          payload: JSON.stringify(e.payload),
          received_at: iso(at),
        })
        .onConflict((oc) => oc.columns(["source", "external_id"]).doNothing())
        .executeTakeFirst();

      return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
    },

    async listUnprocessed(limit = 1000) {
      const rows = await db
        .selectFrom("events")
        .selectAll()
        .where("processed_at", "is", null)
        .orderBy("received_at")
        .orderBy("id")
        .limit(limit)
        .execute();

      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        externalId: r.external_id,
        type: r.type,
        payload: JSON.parse(r.payload) as unknown,
        receivedAt: r.received_at,
        attempts: Number(r.attempts),
      }));
    },

    async noteEventAttempt(source, externalId) {
      const row = await db
        .updateTable("events")
        .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
        .where("source", "=", source)
        .where("external_id", "=", externalId)
        .returning("attempts")
        .executeTakeFirst();

      return Number(row?.attempts ?? 0);
    },

    async markProcessed(source, externalId, error) {
      await db
        .updateTable("events")
        .set({ processed_at: iso(now()), process_error: error ?? null })
        .where("source", "=", source)
        .where("external_id", "=", externalId)
        .where("processed_at", "is", null)
        .execute();
    },

    async enqueue(input: NewWorkItem) {
      const at = now();
      let position = input.position;
      if (position === undefined) {
        const top = await db
          .selectFrom("work_items")
          .select((eb) => eb.fn.max("position").as("p"))
          .where("person", "=", input.person)
          .where("status", "=", "queued")
          .executeTakeFirst();

        position = top?.p === null || top?.p === undefined ? 1 : Number(top.p) + 1;
      }

      const row = await db
        .insertInto("work_items")
        .values({
          id: newId(at.getTime()),
          person: input.person,
          kind: input.kind,
          priority: input.priority ?? 100,
          status: "queued",
          parent_id: input.parentId ?? null,
          subject_type: input.subject?.type ?? null,
          subject_ref: input.subject?.ref ?? null,
          title: input.title,
          session_id: null,
          workspace: null,
          created_at: iso(at),
          updated_at: iso(at),
          trigger: input.trigger,
          attempts: 0,
          not_before: null,
          position,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toItem(row);
    },

    async dequeueNext(person) {
      return db.transaction().execute(async (trx) => {
        let q = trx
          .selectFrom("work_items")
          .selectAll()
          .where("person", "=", person)
          .where("status", "=", "queued")
          .orderBy("priority", "asc")
          .orderBy("position", "asc")
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .limit(1);

        // SQLite has no row locks; its IMMEDIATE transaction already excludes other writers.
        if (dialect === "postgres") {
          q = q.forUpdate().skipLocked();
        }

        const next = await q.executeTakeFirst();
        if (!next) {
          return undefined;
        }

        const row = await trx
          .updateTable("work_items")
          .set({ status: "active", attempts: Number(next.attempts) + 1, updated_at: stamp() })
          .where("id", "=", next.id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return toItem(row);
      });
    },

    async activateItem(id) {
      return db.transaction().execute(async (trx) => {
        const cur = await trx
          .selectFrom("work_items")
          .selectAll()
          .where("id", "=", id)
          .where("status", "=", "queued")
          .executeTakeFirst();

        if (!cur) {
          return undefined;
        }

        const row = await trx
          .updateTable("work_items")
          .set({ status: "active", attempts: Number(cur.attempts) + 1, updated_at: stamp() })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();

        return toItem(row);
      });
    },

    async reorderQueue(entries: QueueOrderEntry[]) {
      await db.transaction().execute(async (trx) => {
        for (const e of entries) {
          const res = await trx
            .updateTable("work_items")
            .set({ priority: e.priority, position: e.position, updated_at: stamp() })
            .where("id", "=", e.id)
            .executeTakeFirst();

          if (Number(res.numUpdatedRows) === 0) {
            throw new Error(`unknown work item: ${e.id}`);
          }
        }
      });
    },

    async getItem(id) {
      const row = await db
        .selectFrom("work_items")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toItem(row) : undefined;
    },

    async listItems(filter = {}) {
      let q = db.selectFrom("work_items").selectAll();
      if (filter.person !== undefined) {
        q = q.where("person", "=", filter.person);
      }

      if (filter.status !== undefined) {
        q = q.where("status", "=", filter.status as WorkItemStatus);
      }

      const rows = await q.orderBy("created_at", "asc").orderBy("id", "asc").execute();
      return rows.map(toItem);
    },

    async updateItem(id, patch: WorkItemPatch) {
      const set: Record<string, unknown> = { updated_at: stamp() };
      if (patch.status !== undefined) {
        set["status"] = patch.status;
      }

      if (patch.title !== undefined) {
        set["title"] = patch.title;
      }

      if (patch.priority !== undefined) {
        set["priority"] = patch.priority;
      }

      if (patch.position !== undefined) {
        set["position"] = patch.position;
      }

      if (patch.failures !== undefined) {
        set["failures"] = patch.failures;
      }

      if (patch.notBefore !== undefined) {
        set["not_before"] = patch.notBefore;
      }

      if (patch.sessionId !== undefined) {
        set["session_id"] = patch.sessionId;
      }

      if (patch.workspace !== undefined) {
        set["workspace"] = patch.workspace;
      }

      if (patch.subject !== undefined) {
        set["subject_type"] = patch.subject.type;
        set["subject_ref"] = patch.subject.ref;
      }

      const row = await db
        .updateTable("work_items")
        .set(set)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();

      if (!row) {
        throw new Error(`unknown work item: ${id}`);
      }

      return toItem(row);
    },

    async startRun(workItemId) {
      const at = now();
      const row = await db
        .insertInto("runs")
        .values({
          id: newId(at.getTime()),
          work_item_id: workItemId,
          started_at: iso(at),
          finished_at: null,
          outcome: null,
          error: null,
          usage: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toRun(row);
    },

    async finishRun(id, result) {
      const res = await db
        .updateTable("runs")
        .set({
          finished_at: stamp(),
          outcome: result.outcome,
          error: result.error ?? null,
          usage: result.usage === undefined ? null : JSON.stringify(result.usage),
        })
        .where("id", "=", id)
        .executeTakeFirst();

      if (Number(res.numUpdatedRows) === 0) {
        throw new Error(`unknown run: ${id}`);
      }
    },

    async listRuns(workItemId) {
      const rows = await db
        .selectFrom("runs")
        .selectAll()
        .where("work_item_id", "=", workItemId)
        .orderBy("id", "asc")
        .execute();

      return rows.map(toRun);
    },

    async appendJournal(workItemId, author, text) {
      const at = now();
      const row = await db
        .insertInto("journal")
        .values({ id: newId(at.getTime()), work_item_id: workItemId, at: iso(at), author, text })
        .returningAll()
        .executeTakeFirstOrThrow();

      return {
        id: row.id,
        workItemId: row.work_item_id,
        at: row.at,
        author: row.author,
        text: row.text,
      };
    },

    async readJournal(workItemId): Promise<JournalEntry[]> {
      const rows = await db
        .selectFrom("journal")
        .selectAll()
        .where("work_item_id", "=", workItemId)
        .orderBy("id", "asc")
        .execute();

      return rows.map((r) => ({
        id: r.id,
        workItemId: r.work_item_id,
        at: r.at,
        author: r.author,
        text: r.text,
      }));
    },

    async upsertSubject(type, ref, data) {
      const json = JSON.stringify(data);
      await db
        .insertInto("subjects")
        .values({ type, ref, data: json, updated_at: stamp() })
        .onConflict((oc) =>
          oc.columns(["type", "ref"]).doUpdateSet({ data: json, updated_at: stamp() }),
        )
        .execute();
    },

    async getSubject(type, ref): Promise<Subject | undefined> {
      const row = await db
        .selectFrom("subjects")
        .selectAll()
        .where("type", "=", type)
        .where("ref", "=", ref)
        .executeTakeFirst();

      return row
        ? {
            type: row.type,
            ref: row.ref,
            data: JSON.parse(row.data) as unknown,
            updatedAt: row.updated_at,
          }
        : undefined;
    },

    async link(from: Ref, to: Ref, relation) {
      await db
        .insertInto("links")
        .values({
          id: newId(now().getTime()),
          from_type: from.type,
          from_ref: from.ref,
          to_type: to.type,
          to_ref: to.ref,
          relation,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();

      const row = await db
        .selectFrom("links")
        .selectAll()
        .where("from_type", "=", from.type)
        .where("from_ref", "=", from.ref)
        .where("to_type", "=", to.type)
        .where("to_ref", "=", to.ref)
        .where("relation", "=", relation)
        .executeTakeFirstOrThrow();

      return toLink(row);
    },

    async unlink(from, to, relation) {
      const res = await db
        .deleteFrom("links")
        .where("from_type", "=", from.type)
        .where("from_ref", "=", from.ref)
        .where("to_type", "=", to.type)
        .where("to_ref", "=", to.ref)
        .where("relation", "=", relation)
        .executeTakeFirst();

      return Number(res.numDeletedRows);
    },

    async queryLinks(query: LinkQuery) {
      let q = db.selectFrom("links").selectAll();
      if (query.from) {
        q = q.where("from_type", "=", query.from.type).where("from_ref", "=", query.from.ref);
      }

      if (query.to) {
        q = q.where("to_type", "=", query.to.type).where("to_ref", "=", query.to.ref);
      }

      if (query.relation !== undefined) {
        q = q.where("relation", "=", query.relation);
      }

      const rows = await q.orderBy("id", "asc").execute();
      return rows.map(toLink);
    },

    async recordLoopGuard(workItemId) {
      await db.insertInto("loop_guard").values({ work_item_id: workItemId, at: stamp() }).execute();
    },

    async countLoopGuard(workItemId, windowMs) {
      const since = iso(new Date(now().getTime() - windowMs));
      const row = await db
        .selectFrom("loop_guard")
        .select((eb) => eb.fn.countAll().as("n"))
        .where("work_item_id", "=", workItemId)
        .where("at", ">=", since)
        .executeTakeFirstOrThrow();

      return Number(row.n);
    },

    async clearLoopGuard(workItemId) {
      await db.deleteFrom("loop_guard").where("work_item_id", "=", workItemId).execute();
    },

    async setPause(scope, reason) {
      await db
        .insertInto("pauses")
        .values({ scope, reason: reason ?? null, paused_at: stamp() })
        .onConflict((oc) => oc.doNothing())
        .execute();
    },

    async clearPause(scope) {
      const res = await db.deleteFrom("pauses").where("scope", "=", scope).executeTakeFirst();
      return Number(res.numDeletedRows) > 0;
    },

    async listPauses(): Promise<Pause[]> {
      const rows = await db.selectFrom("pauses").selectAll().orderBy("scope", "asc").execute();
      return rows.map((r) => ({ scope: r.scope, reason: r.reason, pausedAt: r.paused_at }));
    },

    async createConversation(input: NewConversation) {
      const at = now();
      const row = await db
        .insertInto("conversations")
        .values({
          id: newId(at.getTime()),
          asker_item_id: input.askerItemId,
          target: input.target,
          question: input.question,
          answer: null,
          status: "open",
          depth: input.depth ?? 0,
          created_at: iso(at),
          answered_at: null,
          delivered_at: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return toConversation(row);
    },

    async answerConversation(id, answer) {
      const row = await db
        .updateTable("conversations")
        .set({ answer, status: "answered", answered_at: stamp() })
        .where("id", "=", id)
        .where("status", "=", "open")
        .returningAll()
        .executeTakeFirst();

      if (!row) {
        throw new Error(`conversation ${id} is unknown or already answered`);
      }

      return toConversation(row);
    },

    async getConversation(id) {
      const row = await db
        .selectFrom("conversations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

      return row ? toConversation(row) : undefined;
    },

    async listUndelivered(askerItemId) {
      const rows = await db
        .selectFrom("conversations")
        .selectAll()
        .where("asker_item_id", "=", askerItemId)
        .where("status", "=", "answered")
        .where("delivered_at", "is", null)
        .orderBy("answered_at", "asc")
        .orderBy("id", "asc")
        .execute();

      return rows.map(toConversation);
    },

    async markDelivered(id) {
      await db
        .updateTable("conversations")
        .set({ delivered_at: stamp() })
        .where("id", "=", id)
        .where("delivered_at", "is", null)
        .execute();
    },

    async close() {
      await db.destroy();
    },
  };

  return store;
}
