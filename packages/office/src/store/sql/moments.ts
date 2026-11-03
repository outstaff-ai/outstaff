import { sql } from "kysely";
import type { Db } from "#/store/schema.js";
import type { NewMoment, Store } from "#/store/types.js";
import type { StoreInternals } from "./types.js";

const COLUMNS = [
  "key",
  "person",
  "at",
  "kind",
  "subject_type",
  "subject_ref",
  "work_item_id",
  "actor",
  "actor_name",
  "text",
  "url",
] as const;

const orNull = <T>(v: T | null | undefined): T | null => v ?? null;

/** Records a moment once: a second record with the same key changes nothing. */
export async function insertMoment(db: Db, m: NewMoment): Promise<void> {
  await db
    .insertInto("recall_moments")
    .values({
      key: m.key,
      person: m.person,
      at: m.at,
      kind: m.kind,
      subject_type: orNull(m.subject?.type),
      subject_ref: orNull(m.subject?.ref),
      work_item_id: orNull(m.workItemId),
      actor: orNull(m.actor),
      actor_name: orNull(m.actorName),
      text: m.text,
      url: orNull(m.url),
    })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
}

/** A journal entry as a moment of the item's agent, where the item is. */
export async function insertJournalMoment(db: Db, journalId: string): Promise<void> {
  await db
    .insertInto("recall_moments")
    .columns(COLUMNS)
    .expression(
      db
        .selectFrom("journal as j")
        .innerJoin("work_items as w", "w.id", "j.work_item_id")
        .select([
          sql<string>`${sql.lit("journal:")} || j.id`.as("key"),
          "w.person",
          "j.at",
          sql<string>`${sql.lit("journal")}`.as("kind"),
          "w.subject_type",
          "w.subject_ref",
          "w.id",
          "j.author",
          sql<null>`null`.as("actor_name"),
          "j.text",
          sql<null>`null`.as("url"),
        ])
        .where("j.id", "=", journalId),
    )
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
}

/** What a finished run handed back (its outcome) as a moment of the item's agent. */
export async function insertOutcomeMoment(db: Db, runId: string): Promise<void> {
  await db
    .insertInto("recall_moments")
    .columns(COLUMNS)
    .expression(
      db
        .selectFrom("runs as r")
        .innerJoin("work_items as w", "w.id", "r.work_item_id")
        .select([
          sql<string>`${sql.lit("outcome:")} || r.id`.as("key"),
          "w.person",
          sql<string>`r.finished_at`.as("at"),
          sql<string>`${sql.lit("outcome")}`.as("kind"),
          "w.subject_type",
          "w.subject_ref",
          "w.id",
          sql<string>`w.person`.as("actor"),
          sql<null>`null`.as("actor_name"),
          sql<string>`r.outcome`.as("text"),
          sql<null>`null`.as("url"),
        ])
        .where("r.id", "=", runId)
        .where("r.outcome", "is not", null)
        .where("r.finished_at", "is not", null),
    )
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
}

/** Recording moments, and reading back the events the office indexes itself. */
export function momentQueries({
  db,
}: StoreInternals): Pick<Store, "recordMoment" | "listEventsAfter"> {
  const select = () => db.selectFrom("events").selectAll().orderBy("received_at").orderBy("id");
  const toEvent = (r: Awaited<ReturnType<ReturnType<typeof select>["execute"]>>[number]) => ({
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    type: r.type,
    payload: JSON.parse(r.payload) as unknown,
    receivedAt: r.received_at,
    attempts: Number(r.attempts),
  });

  return {
    recordMoment: (m) => insertMoment(db, m),

    async listEventsAfter({ after, limit }) {
      const page = await (
        after === undefined ? select() : select().where("received_at", ">", after)
      )
        .limit(limit)
        .execute();

      const last = page.at(-1);
      if (!last || page.length < limit) {
        return page.map(toEvent);
      }

      // The rest of the events received at the same time as the last one, so the next page can start after it.
      const tied = await select().where("received_at", "=", last.received_at).execute();

      const seen = new Set(page.map((r) => r.id));
      return [...page, ...tied.filter((r) => !seen.has(r.id))].map(toEvent);
    },
  };
}
