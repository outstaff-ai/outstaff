import type { Store, Pause } from "../types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on the loop guard and pauses. */
export function guardQueries({
  db,
  now,
}: StoreInternals): Pick<
  Store,
  | "recordLoopGuard"
  | "countLoopGuard"
  | "forgetLatestLoopGuard"
  | "clearLoopGuard"
  | "setPause"
  | "clearPause"
  | "listPauses"
> {
  const stamp = () => iso(now());

  return {
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

    async forgetLatestLoopGuard(workItemId) {
      const latest = await db
        .selectFrom("loop_guard")
        .select("at")
        .where("work_item_id", "=", workItemId)
        .orderBy("at", "desc")
        .limit(1)
        .executeTakeFirst();

      if (latest) {
        await db
          .deleteFrom("loop_guard")
          .where("work_item_id", "=", workItemId)
          .where("at", "=", latest.at)
          .execute();
      }
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
  };
}
