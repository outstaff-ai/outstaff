import type { Selectable } from "kysely";
import type { Database, Db } from "#/store/schema.js";
import type { ModelCounts, RunUsageRow, Store } from "#/store/types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";
import { addCounts, isEmpty, usageDelta } from "./usage-delta.js";

type Counters = Pick<
  Selectable<Database["run_usage"]>,
  | "model"
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_creation_tokens"
  | "cost_usd"
>;

const toCounts = (r: Counters): ModelCounts => ({
  model: r.model,
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheReadTokens: Number(r.cache_read_tokens),
  cacheCreationTokens: Number(r.cache_creation_tokens),
  costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
});

const fromCounts = (u: ModelCounts) => ({
  model: u.model,
  input_tokens: u.inputTokens,
  output_tokens: u.outputTokens,
  cache_read_tokens: u.cacheReadTokens,
  cache_creation_tokens: u.cacheCreationTokens,
  cost_usd: u.costUsd,
});

/** Adds a model's usage to the run's row of that model, or starts the row. */
async function addToRun(db: Db, runId: string, u: ModelCounts): Promise<void> {
  const row = await db
    .selectFrom("run_usage")
    .selectAll()
    .where("run_id", "=", runId)
    .where("model", "=", u.model)
    .executeTakeFirst();

  if (!row) {
    await db
      .insertInto("run_usage")
      .values({ run_id: runId, ...fromCounts(u) })
      .execute();

    return;
  }

  await db
    .updateTable("run_usage")
    .set(fromCounts(addCounts(toCounts(row), u)))
    .where("run_id", "=", runId)
    .where("model", "=", u.model)
    .execute();
}

/** Makes the report the session's latest for each of its models. */
async function keepLatest(db: Db, session: string, models: ModelCounts[], at: string) {
  for (const u of models) {
    await db
      .insertInto("session_usage")
      .values({ session_id: session, reported_at: at, ...fromCounts(u) })
      .onConflict((oc) =>
        oc.columns(["session_id", "model"]).doUpdateSet({ reported_at: at, ...fromCounts(u) }),
      )
      .execute();
  }
}

/** The store's queries on what runs used. */
export function usageQueries({
  db,
  now,
}: StoreInternals): Pick<
  Store,
  "recordRunUsage" | "listRunUsage" | "itemsOfTicket" | "itemsWithoutTicket"
> {
  return {
    recordRunUsage(runId, session, models) {
      return db.transaction().execute(async (trx) => {
        const known = await trx
          .selectFrom("session_usage")
          .selectAll()
          .where("session_id", "=", session)
          .execute();

        const was = new Map(known.map((r) => [r.model, toCounts(r)]));
        const added = models.map((u) => usageDelta(u, was.get(u.model))).filter((u) => !isEmpty(u));

        for (const u of added) {
          await addToRun(trx, runId, u);
        }

        await keepLatest(trx, session, models, iso(now()));
        return added;
      });
    },

    async listRunUsage(filter) {
      let q = db
        .selectFrom("run_usage")
        .innerJoin("runs", "runs.id", "run_usage.run_id")
        .innerJoin("work_items", "work_items.id", "runs.work_item_id")
        .select([
          "run_usage.run_id",
          "run_usage.model",
          "run_usage.input_tokens",
          "run_usage.output_tokens",
          "run_usage.cache_read_tokens",
          "run_usage.cache_creation_tokens",
          "run_usage.cost_usd",
          "runs.work_item_id",
          "runs.finished_at",
          "work_items.person",
          "work_items.kind",
        ]);

      if (filter.workItemIds) {
        q = q.where("runs.work_item_id", "in", [...filter.workItemIds, ""]);
      }

      if (filter.runIds) {
        q = q.where("run_usage.run_id", "in", [...filter.runIds, ""]);
      }

      if (filter.since) {
        q = q.where("runs.finished_at", ">=", filter.since);
      }

      if (filter.until) {
        q = q.where("runs.finished_at", "<", filter.until);
      }

      const rows = await q.orderBy("runs.started_at").orderBy("run_usage.model").execute();
      return rows.map((r): RunUsageRow => ({
        ...toCounts(r),
        runId: r.run_id,
        workItemId: r.work_item_id,
        person: r.person,
        kind: r.kind,
        finishedAt: r.finished_at,
      }));
    },

    async itemsOfTicket(ticket) {
      const rows = await db
        .selectFrom("work_items")
        .select(["id", "created_at"])
        .where((eb) =>
          eb.or([
            eb.and([eb("subject_type", "=", "ticket"), eb("subject_ref", "=", ticket)]),
            eb(
              "id",
              "in",
              eb
                .selectFrom("work_item_refs")
                .select("work_item_id")
                .where("ref_type", "=", "ticket")
                .where("ref", "=", ticket),
            ),
          ]),
        )
        .orderBy("created_at")
        .orderBy("id")
        .execute();

      return rows.map((r) => r.id);
    },

    async itemsWithoutTicket(ids) {
      const rows = await db
        .selectFrom("work_items")
        .select(["id", "created_at"])
        .where("id", "in", [...ids, ""])
        .where((eb) =>
          eb.and([
            eb.or([eb("subject_type", "is", null), eb("subject_type", "!=", "ticket")]),
            eb.not(
              eb.exists(
                eb
                  .selectFrom("work_item_refs")
                  .select("work_item_id")
                  .whereRef("work_item_refs.work_item_id", "=", "work_items.id")
                  .where("ref_type", "=", "ticket"),
              ),
            ),
          ]),
        )
        .orderBy("created_at")
        .orderBy("id")
        .execute();

      return rows.map((r) => r.id);
    },
  };
}
