import type {
  Store,
  NewWorkItem,
  QueueOrderEntry,
  WorkItemPatch,
  WorkItemStatus,
} from "../types.js";
import { iso, newId } from "./ids.js";
import { toItem } from "./rows.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on work items and the queue. */
export function itemQueries({
  db,
  dialect,
  now,
}: StoreInternals): Pick<
  Store,
  | "enqueue"
  | "dequeueNext"
  | "activateItem"
  | "reorderQueue"
  | "getItem"
  | "listItems"
  | "updateItem"
> {
  const stamp = () => iso(now());

  return {
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
  };
}
