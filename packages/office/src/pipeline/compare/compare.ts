import type { Comparison, Difference, Outcome } from "./compare.types.js";

/** What an outcome is about: the same target on both sides is compared. */
function target(o: Outcome): string {
  switch (o.type) {
    case "wake":
      return `wake ${o.person} ${o.subject?.type ?? "-"} ${o.subject?.ref ?? "-"}`;
    case "comment":
      return `comment ${o.on}`;
    default:
      return `${o.type} ${o.ticket}`;
  }
}

/** What it does to that target. */
function detail(o: Outcome): string {
  switch (o.type) {
    case "wake":
      return o.kind;
    case "move":
      return o.to;
    case "assign":
      return o.to ? `${o.to.kind} ${o.to.id}` : "nobody";
    case "comment":
      return "";
    case "set_parent":
      return o.parent;
  }
}

const actor = (o: Outcome) => (o.type === "wake" ? undefined : o.as);

/**
 * Compares what the engine did with what the pipeline decided for one event. Outcomes are paired by target (who is
 * woken on what, which ticket is moved, assigned or commented on); a pair that does the same is an agreement, one that
 * does something else is `different`, and an outcome without a partner is missing or extra. Pure.
 */
export function compareOutcomes(
  engine: readonly Outcome[],
  pipeline: readonly Outcome[],
): Comparison {
  const differences: Difference[] = [];
  const left = [...pipeline];
  const unmatched: Outcome[] = [];
  for (const e of engine) {
    const i = left.findIndex((p) => target(p) === target(e) && detail(p) === detail(e));
    if (i < 0) {
      unmatched.push(e);
      continue;
    }

    const [p] = left.splice(i, 1);
    if (actor(e) !== actor(p!)) {
      differences.push({
        kind: "actor_changed",
        engine: e,
        pipeline: p,
        policy: p!.policy,
        note: `attributed to ${actor(p!)}, not the ${actor(e)}`,
      });
    }
  }

  for (const e of unmatched) {
    const i = left.findIndex((p) => target(p) === target(e));
    if (i < 0) {
      differences.push({ kind: "missing_in_pipeline", engine: e });
      continue;
    }

    const [p] = left.splice(i, 1);
    differences.push({ kind: "different", engine: e, pipeline: p, policy: p!.policy });
  }

  for (const p of left) {
    differences.push({ kind: "extra_in_pipeline", pipeline: p, policy: p.policy });
  }

  return { agree: differences.every((d) => d.kind === "actor_changed"), differences };
}
