import { mentionedBy } from "./evaluate-check.js";
import type { Ctx, Resolved } from "./evaluate.types.js";
import { BUILTIN_TEMPLATES, renderTemplate, TemplateError } from "./template.js";
import { variables } from "./template-variables.js";
import type { CanonicalStatus } from "#/ports/types.js";
import type { Action, Effect, EffectTarget, PrRef } from "./types.js";

type CommentSpec = Extract<Action, { comment: unknown }>["comment"];
type ScheduleSpec = Extract<Action, { schedule: unknown }>["schedule"];

/** The recorded requester, else the first listed human. */
const requesterOf = (ctx: Ctx): string | undefined =>
  (ctx.ticket ? ctx.state.requester(ctx.ticket) : undefined) ?? ctx.opts.fallbackRequester;

const noRequester = (ctx: Ctx) =>
  ctx.ticket
    ? `ticket ${ctx.ticket} has no known requester and there is no first-human fallback (the team lists no humans, or policies.hand_back.fallback is none)`
    : "event has no linked ticket";

const agent = (id: string | undefined, skip: string): Resolved<EffectTarget> =>
  id ? { value: { kind: "agent", id } } : { skip };

/** Assignment targets with a name of their own; the rest are `human:<id>` and `role:<role>`. */
const TARGETS = new Map<string, (ctx: Ctx) => Resolved<EffectTarget | null>>([
  ["none", () => ({ value: null })],
  [
    "author",
    (ctx) =>
      agent(
        ctx.pr?.author.kind === "agent" ? ctx.pr.author.person : undefined,
        "pull request has no agent author",
      ),
  ],
  [
    "last_worker",
    (ctx) =>
      agent(
        ctx.ticket ? ctx.state.lastWorker(ctx.ticket) : undefined,
        "no agent has worked on the ticket yet",
      ),
  ],
  ["mentioned", (ctx) => agent(mentionedBy(ctx.event)[0], "the comment mentions no agent")],
  [
    "requester",
    (ctx) => {
      const r = requesterOf(ctx);
      return r ? { value: { kind: "human", id: r } } : { skip: noRequester(ctx) };
    },
  ],
]);

function assignTarget(spec: string, ctx: Ctx): Resolved<EffectTarget | null> {
  const named = TARGETS.get(spec);
  if (named) {
    return named(ctx);
  }

  if (spec.startsWith("human:")) {
    return { value: { kind: "human", id: spec.slice(6) } };
  }

  return agent(ctx.state.personForRole(spec.slice(5)), `no agent plays ${spec}`);
}

/** People to schedule work for that are not assignment targets. */
const PEOPLE = new Map<string, (ctx: Ctx) => Resolved<string>>([
  [
    "doc_author",
    (ctx) => {
      const doc = ctx.event.subject.doc;
      const author = doc ? ctx.state.docAuthor(doc) : undefined;
      return author
        ? { value: author }
        : { skip: "no agent is recorded as the author of the document" };
    },
  ],
  [
    "assignee",
    (ctx) => {
      const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
      return a?.kind === "agent" ? { value: a.id } : { skip: "ticket is not assigned to an agent" };
    },
  ],
]);

/** The agent a schedule's `person` names (`author`, `assignee`, `mentioned`, `role:<role>` ...), or why there is none. */
export function person(spec: string, ctx: Ctx): Resolved<string> {
  const named = PEOPLE.get(spec);
  if (named) {
    return named(ctx);
  }

  const t = assignTarget(spec, ctx);
  if ("skip" in t) {
    return t;
  }

  return t.value?.kind === "agent" ? { value: t.value.id } : { skip: `${spec} is not an agent` };
}

function render(template: string, ctx: Ctx): Resolved<string> {
  const text = ctx.opts.templates?.[template] ?? BUILTIN_TEMPLATES[template];
  if (text === undefined) {
    return { skip: `unknown template "${template}"` };
  }

  try {
    return { value: renderTemplate(text, variables(ctx)) };
  } catch (e) {
    if (e instanceof TemplateError) {
      return { skip: `template "${template}": ${e.message}` };
    }

    throw e;
  }
}

/** A schedule for `other_mentioned` is one effect per agent mentioned after the first; every other action is one. */
export function performAll(a: Action, ctx: Ctx): Resolved<Effect[]> {
  if ("schedule" in a && a.schedule.person === "other_mentioned") {
    const others = mentionedBy(ctx.event).slice(1);
    if (others.length === 0) {
      return { skip: "the comment mentions no second agent" };
    }

    const effects: Effect[] = [];
    for (const handle of others) {
      const r = perform({ schedule: { ...a.schedule, person: handle } }, ctx, handle);
      if ("skip" in r) {
        return r;
      }

      effects.push(r.value);
    }

    return { value: effects };
  }

  const r = perform(a, ctx);
  return "skip" in r ? r : { value: [r.value] };
}

const NEED_TICKET = { skip: "event has no linked ticket" } as const;

function perform(a: Action, ctx: Ctx, forced?: string): Resolved<Effect> {
  if ("move" in a) {
    return move(a.move, ctx);
  }

  if ("assign" in a) {
    return assign(a.assign, ctx);
  }

  return "comment" in a ? comment(a.comment, ctx) : schedule(a.schedule, ctx, forced);
}

function move(to: CanonicalStatus, ctx: Ctx): Resolved<Effect> {
  const { ticket } = ctx;
  if (!ticket) {
    return NEED_TICKET;
  }

  if (ctx.state.ticketStatus(ticket) === to) {
    return { skip: `ticket is already ${to}` };
  }

  return { value: { type: "move", ticket, to } };
}

function assign(spec: string, ctx: Ctx): Resolved<Effect> {
  const { ticket } = ctx;
  if (!ticket) {
    return NEED_TICKET;
  }

  const t = assignTarget(spec, ctx);
  return "skip" in t ? t : { value: { type: "assign", ticket, to: t.value } };
}

function comment(spec: CommentSpec, ctx: Ctx): Resolved<Effect> {
  const template = typeof spec === "string" ? spec : spec.template;
  const on = typeof spec === "string" ? "ticket" : (spec.on ?? "ticket");
  const target = commentTarget(on, ctx);
  if ("skip" in target) {
    return target;
  }

  const body = render(template, ctx);
  return "skip" in body
    ? body
    : { value: { type: "comment", on: target.value, template, body: body.value } };
}

function commentTarget(
  on: "ticket" | "pr",
  ctx: Ctx,
): Resolved<{ ticket: string } | { pr: PrRef }> {
  if (on === "pr") {
    const pr = ctx.event.subject.pr;
    return pr ? { value: { pr } } : { skip: "event has no pull request" };
  }

  return ctx.ticket ? { value: { ticket: ctx.ticket } } : NEED_TICKET;
}

/** Work for a person, on the event's ticket, pull request and document; `forced` names the person outright. */
function schedule(spec: ScheduleSpec, ctx: Ctx, forced: string | undefined): Resolved<Effect> {
  const p = forced === undefined ? person(spec.person, ctx) : { value: forced };
  if ("skip" in p) {
    return p;
  }

  const { pr, doc } = ctx.event.subject;

  return {
    value: {
      type: "schedule",
      person: p.value,
      kind: spec.kind,
      priority: spec.priority,
      ...(ctx.ticket ? { ticket: ctx.ticket } : {}),
      ...(pr ? { pr } : {}),
      ...(doc ? { doc } : {}),
    },
  };
}
