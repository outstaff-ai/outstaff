import type { ActTarget, Resolved } from "@outstaff/core";
import { nextReadyTicket } from "./idle.js";
import type { ActSpec, OpSpec, PolicyContext, WakeSpec } from "./policy.types.js";
import type { BookkeepingOp, Proposal, WakeSubject } from "./proposal.types.js";

type Ctx = Omit<PolicyContext, "wake" | "act">;

const drop = (reason: string): Proposal => ({ type: "drop", reason });

/** The subject of a wake: the event's (left for the office to fill in), or for an idle pull the agent's next ready ticket. */
function wakeTarget(
  spec: Omit<WakeSpec, "person">,
  person: string,
  ctx: Ctx,
): Resolved<{ subject?: WakeSubject; next?: string }> {
  if (spec.subject !== "next_ready_ticket") {
    return { value: {} };
  }

  const next = nextReadyTicket(ctx.state.readyTickets(person))?.key;
  return next
    ? { value: { subject: { type: "ticket", ref: next }, next } }
    : { skip: `no ready ticket is assigned to ${person}` };
}

/** A wake of an agent already resolved, with the policy's instruction. */
function wakeOf(
  spec: Omit<WakeSpec, "person">,
  person: string,
  ctx: Ctx,
  reason: string,
): Proposal {
  const target = wakeTarget(spec, person, ctx);
  if ("skip" in target) {
    return drop(target.skip);
  }

  const { subject, next } = target.value;
  const instruction = ctx.render(ctx.instruction ?? "", {
    person,
    ...(next ? { next } : {}),
  });

  if ("skip" in instruction) {
    return drop(`the instruction cannot be rendered: ${instruction.skip}`);
  }

  return {
    type: "wake",
    person,
    kind: spec.kind,
    instruction: instruction.value,
    ...(subject ? { subject } : {}),
    reason,
  };
}

/** `ctx.wake`: wake the person the spec names, or a drop saying why no one can be woken. */
export function proposeWake(ctx: Ctx, spec: WakeSpec, reason = ctx.matched): Proposal[] {
  const person = ctx.person(spec.person);
  return "skip" in person
    ? [drop(`no one to wake: ${person.skip}`)]
    : [wakeOf(spec, person.value, ctx, reason)];
}

function moveOp(to: Extract<OpSpec, { move: unknown }>["move"], ticket: string, ctx: Ctx) {
  return ctx.state.ticketStatus(ticket) === to
    ? { skip: `move: ${ticket} is already ${to}` }
    : { value: { op: "move" as const, ticket, to } };
}

/** Who an assignment goes to: the agent acted for, else the requester or the team's first human. */
function assignee(spec: { assign: "requester" | "self" }, as: string, ticket: string, ctx: Ctx) {
  if (spec.assign === "self") {
    return { kind: "agent", id: as } satisfies ActTarget;
  }

  const human = ctx.state.requester(ticket) ?? ctx.options.fallbackRequester;
  return human ? ({ kind: "human", id: human } satisfies ActTarget) : undefined;
}

function assignOp(
  spec: { assign: "requester" | "self" },
  as: string,
  ticket: string,
  ctx: Ctx,
): Resolved<BookkeepingOp> {
  const to = assignee(spec, as, ticket, ctx);
  if (!to) {
    return { skip: `assign: ${ticket} has no known requester and the team lists no human` };
  }

  return ctx.state.assignee(ticket)?.id === to.id
    ? { skip: `assign: ${ticket} is already assigned to ${to.id}` }
    : { value: { op: "assign", ticket, to } };
}

function parentOp(ticket: string, ctx: Ctx): Resolved<BookkeepingOp> {
  const parent = ctx.event.data["parent"];
  return typeof parent === "string" && parent !== ""
    ? { value: { op: "set_parent", ticket, parent } }
    : { skip: "set_parent: the event names no parent ticket" };
}

function op(spec: OpSpec, as: string, ctx: Ctx): Resolved<BookkeepingOp> {
  const ticket = ctx.ticket;
  if (!ticket) {
    return { skip: `${Object.keys(spec)[0]}: the event has no linked ticket` };
  }

  if ("move" in spec) {
    return moveOp(spec.move, ticket, ctx);
  }

  return "assign" in spec ? assignOp(spec, as, ticket, ctx) : parentOp(ticket, ctx);
}

/** The changes an act makes, and why each other one is not needed. */
function actOps(spec: ActSpec, as: string, ctx: Ctx) {
  const results = spec.ops.map((item) => op(item, as, ctx));
  return {
    ops: results.flatMap((r) => ("value" in r ? [r.value] : [])),
    skipped: results.flatMap((r) => ("skip" in r ? [r.skip] : [])),
  };
}

/**
 * An act, then the wake of the agent it was for: the policy's instruction is the wake's, and the act posts no note,
 * since the agent's own run follows. With nothing to change the agent is still woken.
 */
function actThenWake(spec: ActSpec, then: { kind: string }, as: string, ctx: Ctx, reason: string) {
  const { ops } = actOps(spec, as, ctx);
  const woken = wakeOf(then, as, ctx, reason);
  return ops.length > 0 ? [{ type: "act" as const, as, ops, reason }, woken] : [woken];
}

/** `ctx.act`: the changes for the agent the spec names, then its wake if asked; or a drop saying why there are none. */
export function proposeAct(ctx: Ctx, spec: ActSpec, reason = ctx.matched): Proposal[] {
  const as = ctx.person(spec.as);
  if ("skip" in as) {
    return [drop(`no agent to act for: ${as.skip}`)];
  }

  if (spec.wake) {
    return actThenWake(spec, spec.wake, as.value, ctx, reason);
  }

  const { ops, skipped } = actOps(spec, as.value, ctx);
  if (ops.length === 0) {
    return [drop(`nothing to change: ${skipped.join("; ")}`)];
  }

  const note = ctx.render(ctx.instruction ?? "", { person: as.value });
  if ("skip" in note) {
    return [drop(`the note cannot be rendered: ${note.skip}`)];
  }

  return [{ type: "act", as: as.value, ops, ...(note.value ? { note: note.value } : {}), reason }];
}
