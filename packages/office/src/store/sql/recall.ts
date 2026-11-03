import { type SqlBool, sql } from "kysely";
import type { Database } from "#/store/schema.js";
import type { Moment, MomentQuery, MomentRef, Store } from "#/store/types.js";
import { ftsQuery } from "./fts-query.js";
import type { StoreInternals } from "./types.js";

/** One of these references, on the columns of a reference table. */
const anyRef = (refs: MomentRef[], type: string, ref: string) =>
  sql.join(
    refs.map((r) => sql`(${sql.ref(type)} = ${r.type} and ${sql.ref(ref)} = ${r.ref})`),
    sql` or `,
  );

/**
 * What the person sees: its own moments, and the events about a ticket, pull request or document one of its work
 * items refers to. Chat messages are always someone's own: another agent's conversations are never seen.
 */
const visibleTo = (
  person: string,
) => sql<SqlBool>`(m.person = ${person} or (m.person is null and exists (
  select 1 from work_item_refs r join work_items w on w.id = r.work_item_id
  where w.person = ${person} and r.ref_type = m.subject_type and r.ref = m.subject_ref)))`;

/**
 * About one of the references: it happened there, or a work item of the person that refers to it is the moment's
 * own item, or refers to where the moment happened (a pull request of the ticket, the chat thread that named it).
 */
const aboutAny = (
  person: string,
  refs: MomentRef[],
) => sql<SqlBool>`((${anyRef(refs, "m.subject_type", "m.subject_ref")}) or exists (
  select 1 from work_item_refs a join work_items w on w.id = a.work_item_id
  where w.person = ${person} and (${anyRef(refs, "a.ref_type", "a.ref")}) and (a.work_item_id = m.work_item_id
    or exists (select 1 from work_item_refs b where b.work_item_id = a.work_item_id
      and b.ref_type = m.subject_type and b.ref = m.subject_ref))))`;

const byAny = (names: string[]) => {
  const lower = names.map((n) => n.toLowerCase());
  return sql<SqlBool>`(lower(m.actor) in (${sql.join(lower)}) or lower(m.actor_name) in (${sql.join(lower)}))`;
};

const toMoment = (r: Database["recall_moments"]): Moment => ({
  key: r.key,
  person: r.person,
  at: r.at,
  kind: r.kind,
  subject:
    r.subject_type !== null && r.subject_ref !== null
      ? { type: r.subject_type, ref: r.subject_ref }
      : null,
  workItemId: r.work_item_id,
  actor: r.actor,
  actorName: r.actor_name,
  text: r.text,
  url: r.url,
});

/** The search over an agent's moments: full text on either database, scoped to what the agent saw. */
export function recallQueries({ db, dialect }: StoreInternals): Pick<Store, "searchMoments"> {
  const matches = (text: string) => {
    if (dialect === "postgres") {
      return sql<SqlBool>`m.search @@ websearch_to_tsquery('english', ${text})`;
    }

    const fts = ftsQuery(text);
    return fts === undefined
      ? undefined
      : sql<SqlBool>`m.key in (select key from recall_fts where recall_fts match ${fts})`;
  };

  return {
    async searchMoments(q: MomentQuery) {
      // Nothing to match, or a filter that names no one and nothing: no moment can match.
      const match = matches(q.text);
      if (!match || q.with?.length === 0 || q.about?.length === 0) {
        return [];
      }

      const rows = await db
        .selectFrom("recall_moments as m")
        .select([
          "m.key",
          "m.person",
          "m.at",
          "m.kind",
          "m.subject_type",
          "m.subject_ref",
          "m.work_item_id",
          "m.actor",
          "m.actor_name",
          "m.text",
          "m.url",
        ])
        .where(match)
        .where(visibleTo(q.person))
        .$if(q.since !== undefined, (b) => b.where("m.at", ">=", q.since!))
        .$if(q.before !== undefined, (b) => b.where("m.at", "<", q.before!))
        .$if(q.with !== undefined, (b) => b.where(byAny(q.with!)))
        .$if(q.about !== undefined, (b) => b.where(aboutAny(q.person, q.about!)))
        .orderBy("m.at", "desc")
        .limit(q.limit)
        .execute();

      return rows.map(toMoment);
    },
  };
}
