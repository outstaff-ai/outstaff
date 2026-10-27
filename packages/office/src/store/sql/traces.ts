import type { StoredTrace, Store } from "../types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";

const DEFAULT_LIMIT = 50;

const toTrace = (r: {
  ref: string;
  type: string;
  at: string;
  data: string;
  recorded_at: string;
}): StoredTrace => ({
  ref: r.ref,
  type: r.type,
  at: r.at,
  data: JSON.parse(r.data) as unknown,
  recordedAt: r.recorded_at,
});

/** The store's queries on the event pipeline's traces, on either dialect. */
export function traceQueries({
  db,
  now,
}: StoreInternals): Pick<Store, "recordTrace" | "getTrace" | "listTraces" | "listTracesRecorded"> {
  const stamp = () => iso(now());
  return {
    async recordTrace({ ref, type, at, data }) {
      const json = JSON.stringify(data);
      const recordedAt = stamp();
      await db
        .insertInto("pipeline_traces")
        .values({ ref, type, at, data: json, recorded_at: recordedAt })
        .onConflict((oc) =>
          oc.column("ref").doUpdateSet({ type, at, data: json, recorded_at: recordedAt }),
        )
        .execute();
    },

    async getTrace(ref) {
      const row = await db
        .selectFrom("pipeline_traces")
        .selectAll()
        .where("ref", "=", ref)
        .executeTakeFirst();

      return row ? toTrace(row) : undefined;
    },

    async listTraces(query = {}) {
      let q = db.selectFrom("pipeline_traces").selectAll();
      if (query.before !== undefined) {
        q = q.where("at", "<", query.before);
      }

      const rows = await q
        .orderBy("at", "desc")
        .orderBy("recorded_at", "desc")
        .limit(query.limit ?? DEFAULT_LIMIT)
        .execute();

      return rows.map(toTrace);
    },

    async listTracesRecorded({ from, limit }) {
      let q = db.selectFrom("pipeline_traces").selectAll();
      if (from !== undefined) {
        q = q.where("recorded_at", ">=", from);
      }

      const rows = await q
        .orderBy("recorded_at", "asc")
        .orderBy("ref", "asc")
        .limit(limit)
        .execute();

      return rows.map(toTrace);
    },
  };
}
