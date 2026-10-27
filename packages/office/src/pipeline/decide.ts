import type { Resolved, TemplateError } from "@outstaff/core";
import { prLabel } from "../log.js";
import type { ActOp, ActTarget, Decision, WakeSubject } from "./decisions.types.js";
import type { PipelineEvent } from "./events.types.js";
import { feedbackFor } from "./feedback.js";
import { nextReadyTicket } from "./idle.js";
import { instructionVariables, renderInstruction } from "./instructions.js";
import { resolveSpec } from "./people.js";
import type { DecideSpec, OpSpec, Policy } from "./policy.types.js";
import type { DecideInput } from "./state.types.js";

type WakeSpec = Extract<DecideSpec, { wake: unknown }>["wake"];
type ActSpec = Extract<DecideSpec, { act: unknown }>["act"];

/** Rendering throws only a TemplateError (an unknown variable, a malformed placeholder). */
const render = (text: string, vars: Record<string, string>): Resolved<string> => {
  try {
    return { value: renderInstruction(text, vars) };
  } catch (error) {
    return { skip: (error as TemplateError).message };
  }
};

function eventSubject(event: PipelineEvent): WakeSubject | undefined {
  const { pr, ticket, doc, chat } = event.subject;
  if (pr) {
    return { type: "pr", ref: prLabel(pr) };
  }

  if (ticket) {
    return { type: "ticket", ref: ticket };
  }

  if (doc) {
    return { type: "doc", ref: doc };
  }

  return chat
    ? { type: "chat", ref: chat.thread ? `${chat.channel}/${chat.thread}` : chat.channel }
    : undefined;
}

/** The subject of a wake: the event's, or for an idle pull the agent's oldest ready ticket. */
function wakeSubject(
  spec: WakeSpec,
  person: string,
  input: DecideInput,
): Resolved<{ subject: WakeSubject; next?: string | undefined }> {
  if (spec.subject !== "next_ready_ticket") {
    const subject = eventSubject(input.event);
    return subject
      ? { value: { subject } }
      : { skip: "the event has no ticket, pull request, document or chat thread" };
  }

  const next = nextReadyTicket(input.state.readyTickets(person))?.key;
  return next
    ? { value: { subject: { type: "ticket", ref: next }, next } }
    : { skip: `no ready ticket is assigned to ${person}` };
}

function wake(policy: Policy, spec: WakeSpec, input: DecideInput): Decision {
  const drop = (reason: string): Decision => ({ type: "drop", policy: policy.id, reason });
  const person = resolveSpec(spec.person, input.ctx, input.opts);
  if ("skip" in person) {
    return drop(`no one to wake: ${person.skip}`);
  }

  const target = wakeSubject(spec, person.value, input);
  if ("skip" in target) {
    return drop(target.skip);
  }

  const vars = instructionVariables(input.ctx, { person: person.value, next: target.value.next });
  const instruction = render(policy.instruction ?? "", vars);
  if ("skip" in instruction) {
    return drop(`the instruction cannot be rendered: ${instruction.skip}`);
  }

  return {
    type: "wake",
    policy: policy.id,
    person: person.value,
    kind: spec.kind,
    instruction: instruction.value,
    feedback: feedbackFor(input.event),
    subject: target.value.subject,
  };
}

type Op<K extends string> = Extract<OpSpec, Record<K, unknown>>;

function commentOp(spec: Op<"comment">, as: string, { ctx }: DecideInput): Resolved<ActOp> {
  const doc = ctx.event.subject.doc;
  const on = ctx.ticket ? { ticket: ctx.ticket } : doc ? { doc } : undefined;
  if (!on) {
    return { skip: "comment: the event has no ticket or document" };
  }

  const body = render(spec.comment, instructionVariables(ctx, { person: as }));
  return "skip" in body
    ? { skip: `comment: ${body.skip}` }
    : { value: { op: "comment", on, body: body.value } };
}

function moveOp(spec: Op<"move">, ticket: string, { ctx }: DecideInput): Resolved<ActOp> {
  return ctx.state.ticketStatus(ticket) === spec.move
    ? { skip: `move: ${ticket} is already ${spec.move}` }
    : { value: { op: "move", ticket, to: spec.move } };
}

/** Who an assignment goes to: the acting agent, else the requester or the team's first human. */
function assignee(
  spec: Op<"assign">,
  as: string,
  ticket: string,
  input: DecideInput,
): ActTarget | undefined {
  if (spec.assign === "self") {
    return { kind: "agent", id: as };
  }

  const human = input.ctx.state.requester(ticket) ?? input.opts.fallbackRequester;
  return human ? { kind: "human", id: human } : undefined;
}

function assignOp(
  spec: Op<"assign">,
  as: string,
  ticket: string,
  input: DecideInput,
): Resolved<ActOp> {
  const to = assignee(spec, as, ticket, input);
  if (!to) {
    return { skip: `assign: ${ticket} has no known requester and the team lists no human` };
  }

  return input.ctx.state.assignee(ticket)?.id === to.id
    ? { skip: `assign: ${ticket} is already assigned to ${to.id}` }
    : { value: { op: "assign", ticket, to } };
}

function parentOp(ticket: string, { ctx }: DecideInput): Resolved<ActOp> {
  const parent = ctx.event.data["parent"];
  return typeof parent === "string" && parent !== ""
    ? { value: { op: "set_parent", ticket, parent } }
    : { skip: "set_parent: the event names no parent ticket" };
}

function op(spec: OpSpec, as: string, input: DecideInput): Resolved<ActOp> {
  if ("comment" in spec) {
    return commentOp(spec, as, input);
  }

  const ticket = input.ctx.ticket;
  if (!ticket) {
    return { skip: `${Object.keys(spec)[0]}: the event has no linked ticket` };
  }

  if ("move" in spec) {
    return moveOp(spec, ticket, input);
  }

  return "assign" in spec ? assignOp(spec, as, ticket, input) : parentOp(ticket, input);
}

/** The changes an act makes, and why each other one is not needed. */
function actOps(
  spec: ActSpec,
  as: string,
  input: DecideInput,
): { ops: ActOp[]; skipped: string[] } {
  const results = spec.ops.map((item) => op(item, as, input));
  return {
    ops: results.flatMap((r) => ("value" in r ? [r.value] : [])),
    skipped: results.flatMap((r) => ("skip" in r ? [r.skip] : [])),
  };
}

function act(policy: Policy, spec: ActSpec, input: DecideInput): Decision {
  const drop = (reason: string): Decision => ({ type: "drop", policy: policy.id, reason });
  const as = resolveSpec(spec.as, input.ctx, input.opts);
  if ("skip" in as) {
    return drop(`no agent to act for: ${as.skip}`);
  }

  const { ops, skipped } = actOps(spec, as.value, input);
  if (ops.length === 0) {
    return drop(`nothing to change: ${skipped.join("; ")}`);
  }

  const note = render(
    policy.instruction ?? "",
    instructionVariables(input.ctx, { person: as.value }),
  );

  if ("skip" in note) {
    return drop(`the note cannot be rendered: ${note.skip}`);
  }

  return {
    type: "act",
    policy: policy.id,
    as: as.value,
    ops,
    ...(note.value ? { note: note.value } : {}),
  };
}

/** The decision of a policy that matched the event. */
export function decide(policy: Policy, input: DecideInput): Decision {
  const d = policy.decide;
  if ("wake" in d) {
    return wake(policy, d.wake, input);
  }

  return "act" in d
    ? act(policy, d.act, input)
    : { type: "drop", policy: policy.id, reason: d.drop.reason };
}
