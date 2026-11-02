import { resolvePerson, type EvaluationContext, type Resolved } from "@outstaff/core";
import type { PersonRef, PersonSpec, PolicyOptions } from "./policy.types.js";

/** The agent who closed the blocker of a `ticket.unblocked`, from its `closedBy`. */
function closer(by: unknown): Resolved<string> {
  const { kind, id } = (by ?? {}) as { kind?: unknown; id?: unknown };
  if (typeof id !== "string" || id === "") {
    return { skip: "the event names no one who closed the blocker" };
  }

  return kind === "agent"
    ? { value: id }
    : { skip: `the blocker was closed by a ${String(kind)}, not an agent` };
}

function one(ref: PersonRef, ctx: EvaluationContext): Resolved<string> {
  if (ref === "actor") {
    const { actor } = ctx.event;
    return actor.kind === "agent"
      ? { value: actor.id }
      : { skip: `the event was caused by a ${actor.kind}, not an agent` };
  }

  if (ref === "addressed") {
    const to = ctx.event.data["addressed"];
    return typeof to === "string" && to !== ""
      ? { value: to }
      : { skip: "the message is addressed to no agent" };
  }

  if (ref === "closer") {
    return closer(ctx.event.data["closedBy"]);
  }

  return resolvePerson(ref, ctx);
}

/** The team agent a spec names: the first of a list that resolves, or why none does. */
export function resolveSpec(
  spec: PersonSpec,
  ctx: EvaluationContext,
  opts: PolicyOptions,
): Resolved<string> {
  const refs: readonly PersonRef[] = typeof spec === "string" ? [spec] : spec;
  const skips: string[] = [];
  for (const ref of refs) {
    const r = one(ref, ctx);
    if ("value" in r) {
      return opts.people.includes(r.value)
        ? r
        : { skip: `${r.value} (${ref}) is not an agent on the team` };
    }

    skips.push(r.skip);
  }

  return { skip: skips.join("; ") };
}
