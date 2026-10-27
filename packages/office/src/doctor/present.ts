import type { DoctorCheck } from "@outstaff/core";
import type { LinkHealth } from "@outstaff/protocol";
import type { StoredDoctorCheck } from "#/store/types.js";

const RANK = { fail: 0, warn: 1, ok: 2 } as const;

/** The stored checks as the link and the health endpoint give them: failures first, then warnings, then the rest. */
export function presentHealth(
  checks: StoredDoctorCheck[],
  lastRun: string | undefined,
  at: Date,
): LinkHealth {
  const sorted = checks.toSorted(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      a.scope.localeCompare(b.scope) ||
      a.name.localeCompare(b.name),
  );

  const count = (s: DoctorCheck["status"]) => checks.filter((c) => c.status === s).length;
  return {
    at: at.toISOString(),
    summary: { ok: count("ok"), warn: count("warn"), fail: count("fail") },
    lastRun: lastRun ?? null,
    checks: sorted,
  };
}

/** Names a check repeats within one run (several notes, say) get a number, so each is stored. */
export function uniqueNames<C extends { name: string }>(checks: C[]): C[] {
  const seen = new Map<string, number>();
  return checks.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c : { ...c, name: `${c.name} (${n})` };
  });
}
