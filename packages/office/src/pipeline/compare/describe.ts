import type {
  Comparison,
  ComparisonSummary,
  Difference,
  EngineRecord,
  Outcome,
} from "./compare.types.js";

/** Who a change is made by or for. */
const by = (as: string) => (as === "office" ? "(by the office)" : `(for ${as})`);

/** One outcome in words. */
export function describeOutcome(o: Outcome): string {
  switch (o.type) {
    case "wake":
      return `wake ${o.person} (${o.kind})${o.subject ? ` on ${o.subject.type} ${o.subject.ref}` : ""}`;
    case "move":
      return `move ${o.ticket} to ${o.to} ${by(o.as)}`;
    case "assign":
      return `assign ${o.ticket} to ${o.to ? `${o.to.kind} ${o.to.id}` : "nobody"} ${by(o.as)}`;
    case "comment":
      return `comment on ${o.on} ${by(o.as)}`;
    case "set_parent":
      return `set the parent of ${o.ticket} to ${o.parent} ${by(o.as)}`;
  }
}

/** One difference in words. */
export function describeDifference(d: Difference): string {
  const sides = [
    d.engine ? `engine: ${describeOutcome(d.engine)}` : undefined,
    d.pipeline ? `pipeline: ${describeOutcome(d.pipeline)}` : undefined,
  ].filter(Boolean);

  return `${d.kind}${d.policy ? ` [${d.policy}]` : ""}: ${sides.join("; ")}${d.note ? ` (${d.note})` : ""}`;
}

/** The engine's side of a trace and the comparison, as lines for `ost explain`. */
export function formatEngine(engine: EngineRecord, comparison: Comparison | undefined): string[] {
  const lines = ["Engine (today):"];
  lines.push(
    ...(engine.effects.length
      ? engine.effects.map((o) => `  ${describeOutcome(o)}`)
      : ["  nothing"]),
  );

  for (const s of engine.skipped ?? []) {
    lines.push(`  skipped: ${describeOutcome(s.outcome)}: ${s.note}`);
  }

  for (const f of engine.failed ?? []) {
    lines.push(`  failed: ${describeOutcome(f.outcome)}: ${f.note}`);
  }

  if (comparison) {
    lines.push("", `Comparison: ${comparison.agree ? "agree" : "differ"}`);
    lines.push(...comparison.differences.map((d) => `  ${describeDifference(d)}`));
  }

  return lines;
}

const counts = (record: Record<string, number | undefined>) =>
  Object.entries(record)
    .toSorted(([a, x], [b, y]) => y! - x! || a.localeCompare(b))
    .map(([k, n]) => `  ${k}: ${n}`);

const rangeLabel = (s: ComparisonSummary) =>
  s.since || s.until ? ` (${s.since ?? "start"} to ${s.until ?? "now"})` : "";

const breakdown = (s: ComparisonSummary): string[] =>
  Object.keys(s.byKind).length > 0
    ? [
        "",
        "Differences by kind:",
        ...counts(s.byKind),
        "",
        "Differences by policy:",
        ...counts(s.byPolicy),
      ]
    : [];

const differing = (s: ComparisonSummary): string[] =>
  s.differing.length > 0
    ? [
        "",
        "Events that differ:",
        ...s.differing.flatMap((e) => [
          `  ${e.at}  ${e.type}  ${e.id}`,
          ...e.differences.map((d) => `    ${describeDifference(d)}`),
        ]),
      ]
    : [];

/** A comparison summary as text, for `ost explain --compare`. */
export function formatSummary(s: ComparisonSummary): string {
  return [
    `Events${rangeLabel(s)}: ${s.events}; compared: ${s.compared}; agree: ${s.agree}; differ: ${s.differ}`,
    ...breakdown(s),
    ...differing(s),
  ].join("\n");
}
