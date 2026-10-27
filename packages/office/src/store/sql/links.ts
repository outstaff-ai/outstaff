import type { Store, LinkQuery, Ref, Subject } from "#/store/types.js";
import { iso, newId } from "./ids.js";
import { toLink } from "./rows.js";
import type { StoreInternals } from "./types.js";

/** The store's queries on subjects and the links between them. */
export function linkQueries({
  db,
  now,
}: StoreInternals): Pick<Store, "upsertSubject" | "getSubject" | "link" | "unlink" | "queryLinks"> {
  const stamp = () => iso(now());

  return {
    async upsertSubject(type, ref, data) {
      const json = JSON.stringify(data);
      await db
        .insertInto("subjects")
        .values({ type, ref, data: json, updated_at: stamp() })
        .onConflict((oc) =>
          oc.columns(["type", "ref"]).doUpdateSet({ data: json, updated_at: stamp() }),
        )
        .execute();
    },

    async getSubject(type, ref): Promise<Subject | undefined> {
      const row = await db
        .selectFrom("subjects")
        .selectAll()
        .where("type", "=", type)
        .where("ref", "=", ref)
        .executeTakeFirst();

      return row
        ? {
            type: row.type,
            ref: row.ref,
            data: JSON.parse(row.data) as unknown,
            updatedAt: row.updated_at,
          }
        : undefined;
    },

    async link(from: Ref, to: Ref, relation) {
      await db
        .insertInto("links")
        .values({
          id: newId(now().getTime()),
          from_type: from.type,
          from_ref: from.ref,
          to_type: to.type,
          to_ref: to.ref,
          relation,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();

      const row = await db
        .selectFrom("links")
        .selectAll()
        .where("from_type", "=", from.type)
        .where("from_ref", "=", from.ref)
        .where("to_type", "=", to.type)
        .where("to_ref", "=", to.ref)
        .where("relation", "=", relation)
        .executeTakeFirstOrThrow();

      return toLink(row);
    },

    async unlink(from, to, relation) {
      const res = await db
        .deleteFrom("links")
        .where("from_type", "=", from.type)
        .where("from_ref", "=", from.ref)
        .where("to_type", "=", to.type)
        .where("to_ref", "=", to.ref)
        .where("relation", "=", relation)
        .executeTakeFirst();

      return Number(res.numDeletedRows);
    },

    async queryLinks(query: LinkQuery) {
      let q = db.selectFrom("links").selectAll();
      if (query.from) {
        q = q.where("from_type", "=", query.from.type).where("from_ref", "=", query.from.ref);
      }

      if (query.to) {
        q = q.where("to_type", "=", query.to.type).where("to_ref", "=", query.to.ref);
      }

      if (query.relation !== undefined) {
        q = q.where("relation", "=", query.relation);
      }

      const rows = await q.orderBy("id", "asc").execute();
      return rows.map(toLink);
    },
  };
}
