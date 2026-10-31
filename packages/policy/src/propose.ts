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

type AssignSpec = Extract<OpSpec, { assign: unknown }>;

/** A change still needed, with why it goes where it goes when that is a choice; or why it is not needed. */
type OpResult = { value: BookkeepingOp } | { value: BookkeepingOp; why: string } | { skip: string };

type Chosen = { to: ActTarget; why?: string } | { skip: string };

/**
 * Who an assignment goes to: the agent acted for, the agent named (`role:pm`), else the requester or the fallback
 * human, and why.
 */
function assignee(spec: AssignSpec, as: string, ticket: string, ctx: Ctx): Chosen {
  if (spec.assign === "self") {
    return { to: { kind: "agent", id: as } };
  }

  if (spec.assign !== "requester") {
    const agent = ctx.person(spec.assign);
    return "skip" in agent
      ? { skip: `assign: ${agent.skip}` }
      : { to: { kind: "agent", id: agent.value } };
  }

  const requester = ctx.state.requester(ticket);
  if (requester) {
    return { to: { kind: "human", id: requester }, why: "its requester" };
  }

  const fallback = ctx.options.fallbackRequester;
  return fallback
    ? {
        to: { kind: "human", id: fallback },
        why: "the fallback (hand_back.fallback), as no requester is known",
      }
    : {
        skip: `assign: ${ticket} has no known requester and the team lists no human with a tracker identity`,
      };
}

function assignOp(spec: AssignSpec, as: string, ticket: string, ctx: Ctx): OpResult {
  const chosen = assignee(spec, as, ticket, ctx);
  if ("skip" in chosen) {
    return chosen;
  }

  const { to, why } = chosen;
  if (ctx.state.assignee(ticket)?.id === to.id) {
    return { skip: `assign: ${ticket} is already assigned to ${to.id}` };
  }

  const op = { op: "assign" as const, ticket, to };
  return why ? { value: op, why: `assign: ${ticket} to ${to.id}, ${why}` } : { value: op };
}

function parentOp(ticket: string, ctx: Ctx): Resolved<BookkeepingOp> {
  const parent = ctx.event.data["parent"];
  return typeof parent === "string" && parent !== ""
    ? { value: { op: "set_parent", ticket, parent } }
    : { skip: "set_parent: the event names no parent ticket" };
}

/** The event's pull request, to show on its ticket. */
function linkOp(ticket: string, ctx: Ctx): Resolved<BookkeepingOp> {
  const pr = ctx.pr;
  if (!pr) {
    return { skip: "link_pr: the event has no pull request" };
  }

  const { repo, number } = pr.ref;
  return {
    value: { op: "link_pr", ticket, pr: { repo, number, ...(pr.url ? { url: pr.url } : {}) } },
  };
}

function op(spec: OpSpec, as: string, ctx: Ctx): OpResult {
  const ticket = ctx.ticket;
  if (!ticket) {
    return { skip: `${Object.keys(spec)[0]}: the event has no linked ticket` };
  }

  if ("move" in spec) {
    return moveOp(spec.move, ticket, ctx);
  }

  if ("link_pr" in spec) {
    return linkOp(ticket, ctx);
  }

  return "assign" in spec ? assignOp(spec, as, ticket, ctx) : parentOp(ticket, ctx);
}

/**
 * The changes an act makes, its reason with who each assignment goes to and why, and why each other change is not
 * needed.
 */
function actOps(spec: ActSpec, as: string, ctx: Ctx, reason: string) {
  const results = spec.ops.map((item) => op(item, as, ctx));
  const whys = results.flatMap((r) => ("why" in r ? [r.why] : []));
  return {
    ops: results.flatMap((r) => ("value" in r ? [r.value] : [])),
    reason: [reason, ...whys].join("; "),
    skipped: results.flatMap((r) => ("skip" in r ? [r.skip] : [])),
  };
}

/**
 * An act, then the wake of the agent it was for: the policy's instruction is the wake's, and the act posts no note,
 * since the agent's own run follows. With nothing to change the agent is still woken.
 */
function actThenWake(spec: ActSpec, then: { kind: string }, as: string, ctx: Ctx, reason: string) {
  const act = actOps(spec, as, ctx, reason);
  const woken = wakeOf(then, as, ctx, reason);
  return act.ops.length > 0
    ? [{ type: "act" as const, as, ops: act.ops, reason: act.reason }, woken]
    : [woken];
}

/** The note an act posts: its own, else the policy's instruction. */
const noteTemplate = (spec: ActSpec, ctx: Ctx) => spec.note ?? ctx.instruction ?? "";

/** `ctx.act`: the changes for the agent the spec names, then its wake if asked; or a drop saying why there are none. */
export function proposeAct(ctx: Ctx, spec: ActSpec, reason = ctx.matched): Proposal[] {
  const as = ctx.person(spec.as);
  if ("skip" in as) {
    return [drop(`no agent to act for: ${as.skip}`)];
  }

  if (spec.wake) {
    return actThenWake(spec, spec.wake, as.value, ctx, reason);
  }

  const { ops, skipped, reason: why } = actOps(spec, as.value, ctx, reason);
  if (ops.length === 0) {
    return [drop(`nothing to change: ${skipped.join("; ")}`)];
  }

  const note = ctx.render(noteTemplate(spec, ctx), { person: as.value });
  if ("skip" in note) {
    return [drop(`the note cannot be rendered: ${note.skip}`)];
  }

  return [
    { type: "act", as: as.value, ops, ...(note.value ? { note: note.value } : {}), reason: why },
  ];
}
