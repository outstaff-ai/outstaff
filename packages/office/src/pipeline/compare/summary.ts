import type { Trace, TraceStore } from "#/pipeline/trace.types.js";
import type { ComparisonSummary } from "./compare.types.js";

const PAGE = 200;

const bump = (record: Record<string, number>, key: string) => {
  record[key] = (record[key] ?? 0) + 1;
};

/** Adds one compared trace to the summary. */
function tally(
  summary: ComparisonSummary,
  t: Trace & { comparison: NonNullable<Trace["comparison"]> },
) {
  summary.compared++;
  for (const d of t.comparison.differences) {
    bump(summary.byKind as Record<string, number>, d.kind);
    bump(summary.byPolicy, d.policy ?? "(none)");
  }

  if (t.comparison.agree) {
    summary.agree++;
    return;
  }

  summary.differ++;
  summary.differing.push({
    id: t.event.id,
    type: t.event.type,
    at: t.event.at,
    differences: t.comparison.differences,
  });
}

/** Totals and differences over the given traces; only traces with both sides recorded are compared. */
export function summarize(
  traces: readonly Trace[],
  range: { since?: string | undefined; until?: string | undefined } = {},
): ComparisonSummary {
  const summary: ComparisonSummary = {
    ...(range.since ? { since: range.since } : {}),
    ...(range.until ? { until: range.until } : {}),
    events: traces.length,
    compared: 0,
    agree: 0,
    differ: 0,
    byKind: {},
    byPolicy: {},
    differing: [],
  };

  for (const t of traces) {
    if (t.comparison) {
      tally(summary, { ...t, comparison: t.comparison });
    }
  }

  return summary;
}

/** Takes a page's events from `since` on; returns whether the range ends in this page. */
function take(page: Trace[], since: string | undefined, seen: Map<string, Trace>): boolean {
  for (const t of page) {
    if (since !== undefined && t.event.at < since) {
      return true;
    }

    seen.set(t.event.id, t);
  }

  return page.length < PAGE;
}

/** Where the next page starts: just after the oldest time of this one, unless the whole page shares that time. */
function nextBefore(page: Trace[]): string {
  const last = page.at(-1)!.event.at;
  return page[0]!.event.at === last ? last : new Date(Date.parse(last) + 1).toISOString();
}

/**
 * The comparison summary of every event between `since` and `until` (event times), read page by page. A page goes on
 * from just after its oldest time, so events that share that time are read whole.
 */
export async function compareRange(
  store: Pick<TraceStore, "list">,
  range: { since?: string | undefined; until?: string | undefined } = {},
): Promise<ComparisonSummary> {
  const seen = new Map<string, Trace>();
  let before = range.until;
  for (;;) {
    const page = await store.list({ limit: PAGE, ...(before ? { before } : {}) });
    if (take(page, range.since, seen)) {
      return summarize([...seen.values()], range);
    }

    before = nextBefore(page);
  }
}
