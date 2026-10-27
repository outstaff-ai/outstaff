import type { DoctorChecksTable } from "#/store/schema.js";
import type { DoctorStore, NewDoctorCheck, StoredDoctorCheck } from "#/store/doctor.types.js";
import { iso } from "./ids.js";
import type { StoreInternals } from "./types.js";

const toCheck = (r: DoctorChecksTable): StoredDoctorCheck => ({
  scope: r.scope,
  name: r.name,
  status: r.status,
  detail: r.detail,
  ...(r.fix === null ? {} : { fix: r.fix }),
  ...(r.key === null ? {} : { key: r.key }),
  ...(r.adapter === null ? {} : { adapter: r.adapter }),
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
});

const finding = (c: NewDoctorCheck) => ({
  status: c.status,
  detail: c.detail,
  fix: c.fix ?? null,
  key: c.key ?? null,
  adapter: c.adapter ?? null,
});

/** The store's queries on the doctor checks, on either dialect. */
export function doctorQueries({ db, now }: StoreInternals): DoctorStore {
  return {
    async recordDoctorRun(scope, checks) {
      const at = iso(now());
      const latest = new Map(checks.map((c) => [c.name, c]));
      await db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom("doctor_checks")
          .select(["name", "status"])
          .where("scope", "=", scope)
          .execute();

        const before = new Map(rows.map((r) => [r.name, r.status]));
        const gone = rows.filter((r) => !latest.has(r.name)).map((r) => r.name);
        if (gone.length > 0) {
          await trx
            .deleteFrom("doctor_checks")
            .where("scope", "=", scope)
            .where("name", "in", gone)
            .execute();
        }

        for (const c of latest.values()) {
          const kept = before.get(c.name) === c.status;
          await trx
            .insertInto("doctor_checks")
            .values({ scope, name: c.name, ...finding(c), first_seen: at, last_seen: at })
            .onConflict((oc) =>
              oc.columns(["scope", "name"]).doUpdateSet({
                ...finding(c),
                last_seen: at,
                ...(kept ? {} : { first_seen: at }),
              }),
            )
            .execute();
        }
      });
    },

    async listDoctorChecks(scope) {
      let q = db.selectFrom("doctor_checks").selectAll();
      if (scope !== undefined) {
        q = q.where("scope", "=", scope);
      }

      const rows = await q.orderBy("scope", "asc").orderBy("name", "asc").execute();
      return rows.map(toCheck);
    },
  };
}
