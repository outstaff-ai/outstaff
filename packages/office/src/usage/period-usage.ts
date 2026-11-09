import type { LinkResultOf, PeriodGroup, PeriodTotals } from "@outstaff/protocol";
import { periodPieces } from "./period-pieces.js";
import type { Period, PeriodUsageStore, RunCounts, RunPiece } from "./period.types.js";
import { totalsOf } from "./totals.js";

type Group = LinkResultOf<"period_usage">["groups"][number];
type GroupKey = Omit<Group, "totals">;

/** What a group gathers: its usage, its runs' time, and each person's intervals for the busy time. */
interface Gathered {
  key: GroupKey;
  usage: RunCounts[];
  runMs: number;
  busy: Map<string, [number, number][]>;
}

/** The time covered by the intervals, overlaps counted once, in ms. */
function coveredMs(intervals: [number, number][]): number {
  let total = 0;
  let reach = -Infinity;
  for (const [from, to] of intervals.toSorted((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(from, reach));
    reach = Math.max(reach, to);
  }

  return total;
}

function totalsOfGroup(g: Gathered): PeriodTotals {
  const busyMs = [...g.busy.values()].reduce((n, intervals) => n + coveredMs(intervals), 0);
  return { ...totalsOf(g.usage), runSeconds: g.runMs / 1000, busySeconds: busyMs / 1000 };
}

/** The piece's key for each of the groups; `model` is set apart, since a piece has one per model it used. */
const KEYS: Record<Exclude<PeriodGroup, "model">, (p: RunPiece) => Partial<GroupKey>> = {
  person: (p) => ({ person: p.run.person }),
  subject: (p) => ({ subject: p.run.subject }),
  day: (p) => ({ day: p.date }),
  month: (p) => ({ month: p.date.slice(0, 7) }),
};

/** The groups a piece goes in, with the usage it brings to each: one per model it used, when grouped by model. */
function entriesOf(
  p: RunPiece,
  groupBy: Period["groupBy"],
): { key: GroupKey; usage: RunCounts[] }[] {
  const key = Object.assign(
    {},
    ...groupBy.map((g) => (g === "model" ? {} : KEYS[g](p))),
  ) as GroupKey;

  if (!groupBy.includes("model")) {
    return [{ key, usage: p.usage }];
  }

  return p.usage.length === 0
    ? [{ key: { ...key, model: null }, usage: [] }]
    : p.usage.map((u) => ({ key: { ...key, model: u.model }, usage: [u] }));
}

function gather(pieces: readonly RunPiece[], groupBy: Period["groupBy"]): Gathered[] {
  const groups = new Map<string, Gathered>();
  for (const p of pieces) {
    for (const { key, usage } of entriesOf(p, groupBy)) {
      const id = JSON.stringify(key);
      const g: Gathered = groups.get(id) ?? { key, usage: [], runMs: 0, busy: new Map() };
      g.usage.push(...usage);
      g.runMs += p.to - p.from;
      const mine = g.busy.get(p.run.person) ?? [];
      mine.push([p.from, p.to]);
      g.busy.set(p.run.person, mine);
      groups.set(id, g);
    }
  }

  return [...groups.values()];
}

/** By day and month, oldest first, then largest cost first, then by key. */
const order = (a: Group, b: Group) =>
  (a.day ?? "").localeCompare(b.day ?? "") ||
  (a.month ?? "").localeCompare(b.month ?? "") ||
  b.totals.costUsd - a.totals.costUsd ||
  JSON.stringify(a).localeCompare(JSON.stringify(b));

/** The usage and run time of a period: in total, and per group of the keys asked for. */
export async function periodUsage(
  store: PeriodUsageStore,
  period: Period,
): Promise<LinkResultOf<"period_usage">> {
  const from = new Date(period.from).toISOString();
  const to = new Date(period.to).toISOString();
  const runs = await store.listPeriodRuns(from, to);
  const usage = runs.length === 0 ? [] : await store.listRunUsage({ runningIn: { from, to } });
  const pieces = periodPieces(runs, usage, period);
  const [all] = gather(pieces, []);

  return {
    from,
    to,
    tz: period.tz,
    groupBy: [...period.groupBy],
    totals: all ? totalsOfGroup(all) : { ...totalsOf([]), runSeconds: 0, busySeconds: 0 },
    groups:
      period.groupBy.length === 0
        ? []
        : gather(pieces, period.groupBy)
            .map((g) => ({ ...g.key, totals: totalsOfGroup(g) }))
            .toSorted(order),
  };
}
