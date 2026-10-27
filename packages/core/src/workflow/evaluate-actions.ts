import type { RepoRef } from "../ports/types.js";
import { livePrs, mentionedBy } from "./evaluate-check.js";
import type { Ctx, Resolved } from "./evaluate.types.js";
import { BUILTIN_TEMPLATES, renderTemplate, TemplateError } from "./template.js";
import type { Action, Effect, EffectTarget, PrRef, WorkflowPr, WorkflowState } from "./types.js";

function stackOf(pr: WorkflowPr, state: WorkflowState): WorkflowPr[] {
  const out: WorkflowPr[] = [pr];
  const seen = new Set<string>([key(pr.ref)]);
  let level: WorkflowPr[] = [pr];
  for (let depth = 0; depth < 50 && level.length > 0; depth++) {
    const next: WorkflowPr[] = [];
    for (const p of level) {
      for (const above of state.stackedOn(p.ref.repo, p.headRef)) {
        if (seen.has(key(above.ref))) {
          continue;
        }

        seen.add(key(above.ref));
        next.push(above);
      }
    }

    next.sort((a, b) => a.ref.number - b.ref.number);
    out.push(...next);
    level = next;
  }

  return out;
}

const repoName = (r: RepoRef) => `${r.owner}/${r.name}`;
function key(ref: PrRef): string {
  return `${repoName(ref.repo)}#${ref.number}`;
}

function variables(ctx: Ctx): Record<string, string> {
  const pr = ctx.pr;
  const stack = pr ? stackOf(pr, ctx.state) : [];
  const ticketPrs = ctx.ticket
    ? livePrs(ctx.state.pullRequestsOf(ctx.ticket)).toSorted((a, b) => a.ref.number - b.ref.number)
    : [];

  return {
    ticket: ctx.ticket ?? "",
    status: (ctx.ticket && ctx.state.ticketStatus(ctx.ticket)) || "",
    "actor.id": ctx.event.actor.id,
    "actor.kind": ctx.event.actor.kind,
    "event.type": ctx.event.type,
    "pr.number": pr ? String(pr.ref.number) : "",
    "pr.title": pr?.title ?? "",
    "pr.url": pr?.url ?? "",
    "pr.repo": pr ? repoName(pr.ref.repo) : "",
    "pr.base": pr?.baseRef ?? "",
    "pr.head": pr?.headRef ?? "",
    "pr.author": pr?.author.person ?? pr?.author.login ?? "",
    "ticket.prs": ticketPrs
      .map((p) => `- #${p.ref.number} ${p.title}${p.url ? ` (${p.url})` : ""}`)
      .join("\n"),
    "ticket.prs.count": String(ticketPrs.length),
    stack: stack
      .map((p, i) => `${i + 1}. #${p.ref.number} ${p.title}${p.url ? ` (${p.url})` : ""}`)
      .join("\n"),
    "stack.count": String(stack.length),
  };
}

/** The recorded requester, else the first listed human. */
const requesterOf = (ctx: Ctx): string | undefined =>
  (ctx.ticket ? ctx.state.requester(ctx.ticket) : undefined) ?? ctx.opts.fallbackRequester;

const noRequester = (ctx: Ctx) =>
  ctx.ticket
    ? `ticket ${ctx.ticket} has no known requester and there is no first-human fallback (the team lists no humans, or policies.hand_back.fallback is none)`
    : "event has no linked ticket";

function assignTarget(spec: string, ctx: Ctx): Resolved<EffectTarget | null> {
  if (spec === "none") {
    return { value: null };
  }

  if (spec === "author") {
    const agentId = ctx.pr?.author.kind === "agent" ? ctx.pr.author.person : undefined;
    return agentId
      ? { value: { kind: "agent", id: agentId } }
      : { skip: "pull request has no agent author" };
  }

  if (spec === "last_worker") {
    const p = ctx.ticket ? ctx.state.lastWorker(ctx.ticket) : undefined;
    return p
      ? { value: { kind: "agent", id: p } }
      : { skip: "no agent has worked on the ticket yet" };
  }

  if (spec === "mentioned") {
    const first = mentionedBy(ctx.event)[0];
    return first
      ? { value: { kind: "agent", id: first } }
      : { skip: "the comment mentions no agent" };
  }

  if (spec === "requester") {
    const r = requesterOf(ctx);
    return r ? { value: { kind: "human", id: r } } : { skip: noRequester(ctx) };
  }

  if (spec.startsWith("human:")) {
    return { value: { kind: "human", id: spec.slice(6) } };
  }

  const agentId = ctx.state.personForRole(spec.slice(5));
  return agentId ? { value: { kind: "agent", id: agentId } } : { skip: `no agent plays ${spec}` };
}

function person(spec: string, ctx: Ctx): Resolved<string> {
  if (spec === "doc_author") {
    const doc = ctx.event.subject.doc;
    const author = doc ? ctx.state.docAuthor(doc) : undefined;
    return author
      ? { value: author }
      : { skip: "no agent is recorded as the author of the document" };
  }

  if (spec === "assignee") {
    const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
    return a?.kind === "agent" ? { value: a.id } : { skip: "ticket is not assigned to an agent" };
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

function perform(a: Action, ctx: Ctx, forced?: string): Resolved<Effect> {
  const { ticket } = ctx;
  const needTicket = { skip: "event has no linked ticket" } as const;
  if ("move" in a) {
    if (!ticket) {
      return needTicket;
    }

    if (ctx.state.ticketStatus(ticket) === a.move) {
      return { skip: `ticket is already ${a.move}` };
    }

    return { value: { type: "move", ticket, to: a.move } };
  }

  if ("assign" in a) {
    if (!ticket) {
      return needTicket;
    }

    const t = assignTarget(a.assign, ctx);
    return "skip" in t ? t : { value: { type: "assign", ticket, to: t.value } };
  }

  if ("comment" in a) {
    const template = typeof a.comment === "string" ? a.comment : a.comment.template;
    const on = typeof a.comment === "string" ? "ticket" : (a.comment.on ?? "ticket");
    const target =
      on === "pr"
        ? ctx.event.subject.pr
          ? { pr: ctx.event.subject.pr }
          : undefined
        : ticket
          ? { ticket }
          : undefined;

    if (!target) {
      return { skip: on === "pr" ? "event has no pull request" : needTicket.skip };
    }

    const body = render(template, ctx);
    return "skip" in body
      ? body
      : { value: { type: "comment", on: target, template, body: body.value } };
  }

  {
    const p = forced === undefined ? person(a.schedule.person, ctx) : { value: forced };
    if ("skip" in p) {
      return p;
    }

    const e: Effect = {
      type: "schedule",
      person: p.value,
      kind: a.schedule.kind,
      priority: a.schedule.priority,
    };

    if (ticket) {
      e.ticket = ticket;
    }

    if (ctx.event.subject.pr) {
      e.pr = ctx.event.subject.pr;
    }

    if (ctx.event.subject.doc) {
      e.doc = ctx.event.subject.doc;
    }

    return { value: e };
  }
}
