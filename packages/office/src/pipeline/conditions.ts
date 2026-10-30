import { checkCondition, type Condition, type EvaluationContext } from "@outstaff/core";
import type { ConditionResult, PipelineCondition, PipelineLeaf } from "./policy.types.js";

const isLeaf = (c: PipelineCondition): c is PipelineLeaf => "actor_is" in c;

type Who = (ctx: EvaluationContext) => string | undefined;

/** The agent each `actor_is` names, if there is one. */
const WHO: Record<PipelineLeaf["actor_is"], Who> = {
  assignee: (ctx) => {
    const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
    return a?.kind === "agent" ? a.id : undefined;
  },
  author: (ctx) => ctx.pr?.author.person,
  doc_author: (ctx) => {
    const doc = ctx.event.subject.doc;
    return doc ? ctx.state.docAuthor(doc) : undefined;
  },
  last_worker: (ctx) => (ctx.ticket ? ctx.state.lastWorker(ctx.ticket) : undefined),
};

function actorIs(c: PipelineLeaf, ctx: EvaluationContext): ConditionResult {
  const { actor } = ctx.event;
  const who = WHO[c.actor_is](ctx);
  const ok = actor.kind === "agent" && actor.id === who;
  const named = who ? ` (${who})` : "";
  const detail = `actor ${actor.id} is ${ok ? "" : "not "}the ${c.actor_is.replace("_", " ")}${named}`;
  return ok ? { ok, detail } : { ok, detail, failed: c };
}

function all(c: { all: PipelineCondition[] }, ctx: EvaluationContext): ConditionResult {
  const failing = c.all.map((child) => evaluateCondition(child, ctx)).find((r) => !r.ok);
  return failing ?? { ok: true, detail: "all conditions hold" };
}

function any(c: { any: PipelineCondition[] }, ctx: EvaluationContext): ConditionResult {
  const rs = c.any.map((child) => evaluateCondition(child, ctx));
  const hit = rs.find((r) => r.ok);
  return hit ?? { ok: false, detail: `none of: ${rs.map((r) => r.detail).join("; ")}`, failed: c };
}

function not(c: { not: PipelineCondition }, ctx: EvaluationContext): ConditionResult {
  const r = evaluateCondition(c.not, ctx);
  return r.ok
    ? { ok: false, detail: `not (${r.detail})`, failed: c }
    : { ok: true, detail: `${r.detail}, so not-condition holds` };
}

function leaf(c: PipelineCondition, ctx: EvaluationContext): ConditionResult {
  if (isLeaf(c)) {
    return actorIs(c, ctx);
  }

  const r = checkCondition(c as Condition, ctx);
  return r.ok ? r : { ...r, failed: c };
}

/**
 * Whether a condition holds. Combinations are walked here so pipeline leaves can sit inside them; the other leaves are
 * checked by the shared condition evaluator.
 */
export function evaluateCondition(c: PipelineCondition, ctx: EvaluationContext): ConditionResult {
  if ("all" in c) {
    return all(c, ctx);
  }

  if ("any" in c) {
    return any(c, ctx);
  }

  return "not" in c ? not(c, ctx) : leaf(c, ctx);
}
