import type { Store, NewEvent } from "#/store/types.js";
import { iso, newId } from "./ids.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on cursors and the event log. */
export function eventQueries({
  db,
  now,
}: StoreInternals): Pick<
  Store,
  | "getCursor"
  | "setCursor"
  | "recordEvent"
  | "listUnprocessed"
  | "noteEventAttempt"
  | "markProcessed"
> {
  const stamp = () => iso(now());

  return {
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
  };
}
