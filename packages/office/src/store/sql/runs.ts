import type { Store, JournalEntry } from "#/store/types.js";
import { iso, newId } from "./ids.js";
import { toRun } from "./rows.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on runs and the journal. */
export function runQueries({
  db,
  now,
}: StoreInternals): Pick<
  Store,
  "startRun" | "finishRun" | "listRuns" | "tagRun" | "appendJournal" | "readJournal"
> {
  const stamp = () => iso(now());

  return {
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
          runtime: null,
          model: null,
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

    async tagRun(workItemId, tags) {
      const set = {
        ...(tags.runtime === undefined ? {} : { runtime: tags.runtime }),
        ...(tags.model === undefined ? {} : { model: tags.model }),
      };

      const open = await db
        .selectFrom("runs")
        .select("id")
        .where("work_item_id", "=", workItemId)
        .where("finished_at", "is", null)
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();

      if (open && Object.keys(set).length > 0) {
        await db.updateTable("runs").set(set).where("id", "=", open.id).execute();
      }
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
  };
}
