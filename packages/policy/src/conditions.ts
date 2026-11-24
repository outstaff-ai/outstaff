import { checkCondition, type Condition, type EvaluationContext } from "@outstaff/core";
import type {
  ActorIsLeaf,
  AwaitedLeaf,
  ConditionResult,
  PipelineCondition,
  PolicyState,
} from "./policy.types.js";

const isActorIs = (c: PipelineCondition): c is ActorIsLeaf => "actor_is" in c;
const isAwaited = (c: PipelineCondition): c is AwaitedLeaf => "awaited_human" in c;

type Who = (ctx: EvaluationContext) => string | undefined;

/** The agent each `actor_is` names, if there is one. */
const WHO: Record<ActorIsLeaf["actor_is"], Who> = {
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
  blocked_agent: (ctx) => (ctx.ticket ? ctx.state.blockedAgent(ctx.ticket) : undefined),
};

function actorIs(c: ActorIsLeaf, ctx: EvaluationContext): ConditionResult {
  const { actor } = ctx.event;
  const who = WHO[c.actor_is](ctx);
  const ok = actor.kind === "agent" && actor.id === who;
  const named = who ? ` (${who})` : "";
  const detail = `actor ${actor.id} is ${ok ? "" : "not "}the ${c.actor_is.replace("_", " ")}${named}`;
  return ok ? { ok, detail } : { ok, detail, failed: c };
}

/** Whether an agent waits on the event's actor on the ticket, naming each one and when it mentioned them. */
function awaited(c: AwaitedLeaf, ctx: EvaluationContext): ConditionResult {
  // The pipeline's event, whose time is the comment's as the tracker gave it.
  const { actor, at } = ctx.event as EvaluationContext["event"] & { at?: string };
  // A policy's conditions are checked against its PolicyState, which knows who waits on whom.
  const state = ctx.state as Partial<PolicyState>;
  const waiting =
    ctx.ticket && at && state.waitingOn ? state.waitingOn(ctx.ticket, actor.id, at) : [];

  const on = ctx.ticket ?? "the ticket";
  const detail =
    waiting.length > 0
      ? `${waiting.map((w) => `${w.agent} (mentioned them at ${w.at})`).join(", ")} ${waiting.length > 1 ? "wait" : "waits"} on ${actor.id} on ${on}`
      : `no agent waits on ${actor.id} on ${on}`;

  const ok = waiting.length > 0 === c.awaited_human;
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
  if (isActorIs(c)) {
    return actorIs(c, ctx);
  }

  if (isAwaited(c)) {
    return awaited(c, ctx);
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
