import { checkCondition, type Condition, type EvaluationContext } from "@outstaff/core";
import type { ConditionResult, PipelineCondition, PipelineLeaf } from "./policy.types.js";

const isLeaf = (c: PipelineCondition): c is PipelineLeaf => "actor_is" in c;

function actorIs(c: PipelineLeaf, ctx: EvaluationContext): ConditionResult {
  const { actor } = ctx.event;
  let who: string | undefined;
  if (c.actor_is === "assignee") {
    const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
    who = a?.kind === "agent" ? a.id : undefined;
  } else if (c.actor_is === "author") {
    who = ctx.pr?.author.person;
  } else {
    who = ctx.event.subject.doc ? ctx.state.docAuthor(ctx.event.subject.doc) : undefined;
  }

  const ok = actor.kind === "agent" && who !== undefined && actor.id === who;
  return {
    ok,
    detail: `actor ${actor.id} is ${ok ? "" : "not "}the ${c.actor_is.replace("_", " ")}${who ? ` (${who})` : ""}`,
    ...(ok ? {} : { failed: c }),
  };
}

/**
 * Whether a condition holds. Combinations are walked here so pipeline leaves can sit inside them; workflow leaves are
 * checked by the workflow rules' own evaluator.
 */
export function evaluateCondition(c: PipelineCondition, ctx: EvaluationContext): ConditionResult {
  if ("all" in c) {
    for (const child of c.all) {
      const r = evaluateCondition(child, ctx);
      if (!r.ok) {
        return r;
      }
    }

    return { ok: true, detail: "all conditions hold" };
  }

  if ("any" in c) {
    const rs = c.any.map((child) => evaluateCondition(child, ctx));
    const hit = rs.find((r) => r.ok);
    return (
      hit ?? { ok: false, detail: `none of: ${rs.map((r) => r.detail).join("; ")}`, failed: c }
    );
  }

  if ("not" in c) {
    const r = evaluateCondition(c.not, ctx);
    return r.ok
      ? { ok: false, detail: `not (${r.detail})`, failed: c }
      : { ok: true, detail: `${r.detail}, so not-condition holds` };
  }

  if (isLeaf(c)) {
    return actorIs(c, ctx);
  }

  const r = checkCondition(c as Condition, ctx);
  return r.ok ? r : { ...r, failed: c };
}
