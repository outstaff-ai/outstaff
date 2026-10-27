import type {
  Store,
  NewWorkItem,
  QueueOrderEntry,
  WorkItemPatch,
  WorkItemStatus,
} from "#/store/types.js";
import { iso, newId } from "./ids.js";
import { toItem } from "./rows.js";
import type { StoreInternals } from "./types.js";

/** The column of each patch field that is stored as it is. */
const PATCH_COLUMNS = {
  status: "status",
  title: "title",
  priority: "priority",
  position: "position",
  failures: "failures",
  notBefore: "not_before",
  sessionId: "session_id",
  workspace: "workspace",
} as const;

const subjectColumns = (subject: { type: string; ref: string } | undefined) => ({
  subject_type: subject?.type ?? null,
  subject_ref: subject?.ref ?? null,
});

/** The columns a patch sets: only its fields that are not undefined. */
function patchColumns(patch: WorkItemPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const value = patch[field as keyof typeof PATCH_COLUMNS];
    if (value !== undefined) {
      set[column] = value;
    }
  }

  return patch.subject === undefined ? set : { ...set, ...subjectColumns(patch.subject) };
}

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

  /** Behind the person's other queued items. */
  const nextPosition = async (person: string): Promise<number> => {
    const top = await db
      .selectFrom("work_items")
      .select((eb) => eb.fn.max("position").as("p"))
      .where("person", "=", person)
      .where("status", "=", "queued")
      .executeTakeFirst();

    return top?.p === null || top?.p === undefined ? 1 : Number(top.p) + 1;
  };

  return {
    async enqueue(input: NewWorkItem) {
      const at = now();
      const position = input.position ?? (await nextPosition(input.person));

      const row = await db
        .insertInto("work_items")
        .values({
          id: newId(at.getTime()),
          person: input.person,
          kind: input.kind,
          priority: input.priority ?? 100,
          status: "queued",
          parent_id: input.parentId ?? null,
          ...subjectColumns(input.subject),
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
      const set = { updated_at: stamp(), ...patchColumns(patch) };
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
