import { sql, type Selectable } from "kysely";
import type { Database, Db } from "#/store/schema.js";
import type { ItemRef, ItemRefRole, ItemRefType, NewItemRef, Store } from "#/store/types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";

const toRef = (r: Selectable<Database["work_item_refs"]>): ItemRef => ({
  workItemId: r.work_item_id,
  type: r.ref_type as ItemRefType,
  ref: r.ref,
  ...(r.url === null ? {} : { url: r.url }),
  role: r.role as ItemRefRole,
  source: r.source,
  addedAt: r.added_at,
});

/** Subject types that are references of their own. */
const SUBJECT_REFS = new Set<string>(["ticket", "pr", "doc"]);

/** The `subject` reference of a new item, when its subject is something an item can refer to. */
export function subjectRef(
  subject: { type: string; ref: string } | undefined,
  source: string,
): NewItemRef[] {
  return subject && SUBJECT_REFS.has(subject.type)
    ? [{ type: subject.type as ItemRefType, ref: subject.ref, role: "subject", source }]
    : [];
}

/** Records references of an item; the first record of each keeps its role, source and time. */
export async function writeItemRefs(
  db: Db,
  at: string,
  workItemId: string,
  refs: NewItemRef[],
): Promise<void> {
  for (const r of refs) {
    await db
      .insertInto("work_item_refs")
      .values({
        work_item_id: workItemId,
        ref_type: r.type,
        ref: r.ref,
        url: r.url ?? null,
        role: r.role,
        source: r.source,
        added_at: at,
      })
      .onConflict((oc) =>
        oc
          .columns(["work_item_id", "ref_type", "ref"])
          .doUpdateSet({ url: sql`coalesce(work_item_refs.url, excluded.url)` }),
      )
      .execute();
  }
}

/** The store's queries on what work items refer to. */
export function refQueries({
  db,
  now,
}: StoreInternals): Pick<Store, "addItemRefs" | "listItemRefs" | "findItemRefs"> {
  return {
    addItemRefs: (workItemId, refs) => writeItemRefs(db, iso(now()), workItemId, refs),

    async listItemRefs(workItemId) {
      const rows = await db
        .selectFrom("work_item_refs")
        .selectAll()
        .where("work_item_id", "=", workItemId)
        .orderBy("added_at", "asc")
        .orderBy("ref_type", "asc")
        .orderBy("ref", "asc")
        .execute();

      return rows.map(toRef);
    },

    async findItemRefs(type, ref) {
      const rows = await db
        .selectFrom("work_item_refs")
        .selectAll()
        .where("ref_type", "=", type)
        .where("ref", "=", ref)
        .orderBy("added_at", "asc")
        .orderBy("work_item_id", "asc")
        .execute();

      return rows.map(toRef);
    },
  };
}
