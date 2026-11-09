import type { LinkResultOf } from "@outstaff/protocol";
import type { RunUsageRow, Store } from "#/store/types.js";
import { groupTotals, NO_USAGE, totalsOf } from "./totals.js";

/** The usage of runs that finished in a window: per person, with the part that names no ticket, and per day. */
export async function teamUsage(
  store: Pick<Store, "listRunUsage" | "itemsWithoutTicket">,
  window: { since?: string | undefined; until?: string | undefined; now: string },
): Promise<LinkResultOf<"usage">> {
  const rows = await store.listRunUsage({
    ...(window.since ? { since: window.since } : {}),
    ...(window.until ? { until: window.until } : {}),
  });

  const items = [...new Set(rows.map((r) => r.workItemId))];
  const loose = new Set(items.length === 0 ? [] : await store.itemsWithoutTicket(items));
  const unattributed = new Map(
    groupTotals(
      rows.filter((r) => loose.has(r.workItemId)),
      (r) => r.person,
    ).map((g) => [g.key, g.totals]),
  );

  const finished = rows.filter((r) => r.finishedAt !== null);
  return {
    since: window.since ?? null,
    until: window.until ?? window.now,
    byPerson: groupTotals(rows, (r) => r.person).map((g) => ({
      person: g.key,
      totals: g.totals,
      unattributed: unattributed.get(g.key) ?? NO_USAGE,
    })),
    byDay: groupTotals(finished, (r) => (r.finishedAt ?? "").slice(0, 10))
      .map((g) => ({ day: g.key, totals: g.totals }))
      .toSorted((a, b) => a.day.localeCompare(b.day)),
  };
}

/** The rows' usage for the link: their totals and per model, all zero when there are none. */
export function itemUsageOf(rows: readonly RunUsageRow[]): LinkResultOf<"item">["item"]["usage"] {
  return {
    totals: totalsOf(rows),
    models: groupTotals(rows, (r) => r.model).map((g) => ({ model: g.key, totals: g.totals })),
  };
}

/** One run's usage for the link: its totals and per model; null when nothing was recorded. */
export function runUsageOf(
  rows: readonly RunUsageRow[],
): LinkResultOf<"item">["item"]["runs"][number]["usage"] {
  return rows.length === 0 ? null : itemUsageOf(rows);
}
