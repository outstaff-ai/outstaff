import { resolvePerson, type EvaluationContext, type Resolved } from "@outstaff/core";
import type { PersonRef, PersonSpec } from "./policy.types.js";
import type { PipelineOptions } from "./state.types.js";

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

  return resolvePerson(ref, ctx);
}

/** The team agent a spec names: the first of a list that resolves, or why none does. */
export function resolveSpec(
  spec: PersonSpec,
  ctx: EvaluationContext,
  opts: PipelineOptions,
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
