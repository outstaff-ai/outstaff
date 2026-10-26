import type { RepoRef } from "../ports/repo.js";
import type { Action, Condition, Rule } from "./rules.js";
import { isApprover } from "../policies/approvers.js";
import { BUILTIN_TEMPLATES, renderTemplate, TemplateError } from "./template.js";
import {
  DEFAULT_NEEDS_HUMAN_LABEL,
  type Effect,
  type EffectTarget,
  type PrRef,
  type WorkflowEvent,
  type WorkflowOptions,
  type WorkflowPr,
  type WorkflowState,
} from "./types.js";

export interface RuleExplanation {
  id: string;
  matched: boolean;

  /** Why the rule did or did not fire. */
  reason: string;
  effects: Effect[];

  /** Actions that matched but produced nothing, with the reason. */
  skipped: string[];
}

export interface WorkflowExplanation {
  event: WorkflowEvent;
  rules: RuleExplanation[];

  /** Final ordered, deduplicated effects. */
  effects: Effect[];
}

interface Ctx {
  event: WorkflowEvent;
  state: WorkflowState;
  opts: WorkflowOptions;
  ticket: string | undefined;
  pr: WorkflowPr | undefined;
}

type Check = { ok: boolean; detail: string };

/** The agents a comment names, first mention first: the handles the office put in `data.mentions`. */
const mentionedBy = (event: WorkflowEvent): string[] => {
  const found = event.data["mentions"];
  return Array.isArray(found)
    ? [...new Set(found.filter((m): m is string => typeof m === "string" && m !== ""))]
    : [];
};

/** The pull requests that count toward a ticket's share: a closed one that never merged does not. */
const livePrs = (prs: WorkflowPr[]) => prs.filter((p) => p.state !== "closed");
const list = (xs: readonly string[]) => `[${xs.join(", ")}]`;

function check(c: Condition, ctx: Ctx): Check {
  if ("all" in c) {
    for (const child of c.all) {
      const r = check(child, ctx);
      if (!r.ok) {
        return r;
      }
    }

    return { ok: true, detail: "all conditions hold" };
  }

  if ("any" in c) {
    const rs = c.any.map((child) => check(child, ctx));
    const hit = rs.find((r) => r.ok);
    return hit ?? { ok: false, detail: `none of: ${rs.map((r) => r.detail).join("; ")}` };
  }

  if ("not" in c) {
    const r = check(c.not, ctx);
    return {
      ok: !r.ok,
      detail: r.ok ? `not (${r.detail})` : `${r.detail}, so not-condition holds`,
    };
  }

  if ("ticket_status" in c) {
    const s = ctx.ticket ? ctx.state.ticketStatus(ctx.ticket) : undefined;
    const detail = `ticket status ${s ?? (ctx.ticket ? "unknown" : "none (no linked ticket)")} in ${list(c.ticket_status)}`;
    return { ok: s !== undefined && c.ticket_status.includes(s), detail };
  }

  if ("moved_to" in c) {
    const to = ctx.event.data["to"];
    return {
      ok: typeof to === "string" && (c.moved_to as string[]).includes(to),
      detail: `moved to ${String(to ?? "none")} in ${list(c.moved_to)}`,
    };
  }

  if ("actor_kind" in c) {
    return {
      ok: ctx.event.actor.kind === c.actor_kind,
      detail: `actor is ${ctx.event.actor.kind}, wanted ${c.actor_kind}`,
    };
  }

  if ("assignee_kind" in c) {
    const a = ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined;
    const kind = a?.kind ?? "none";
    return {
      ok: kind === c.assignee_kind,
      detail: `assignee is ${kind}, wanted ${c.assignee_kind}`,
    };
  }

  if ("has_label" in c) {
    const label =
      c.has_label === "$needs_human"
        ? (ctx.opts.needsHumanLabel ?? DEFAULT_NEEDS_HUMAN_LABEL)
        : c.has_label;

    return {
      ok: ctx.ticket !== undefined && ctx.state.hasLabel(ctx.ticket, label),
      detail: `ticket has label "${label}"`,
    };
  }

  if ("pr_author_kind" in c) {
    const kind = ctx.pr?.author.kind;
    return {
      ok: kind === c.pr_author_kind,
      detail: `pull request author is ${kind ?? "unknown"}, wanted ${c.pr_author_kind}`,
    };
  }

  if ("approver" in c) {
    const actor = ctx.event.actor;
    const ok =
      isApprover(
        ctx.opts.approvers ?? ["humans"],
        { kind: actor.kind, id: actor.id, trusted: ctx.event.data["untrusted"] !== true },
        { humans: ctx.opts.humans },
        (role) => ctx.state.personForRole(role),
      ) === c.approver;

    return { ok, detail: `actor ${actor.id} is ${c.approver ? "" : "not "}an allowed approver` };
  }

  if ("pr_draft" in c) {
    const draft = ctx.pr?.draft;
    return {
      ok: draft !== undefined && draft === c.pr_draft,
      detail: `pull request draft is ${draft ?? "unknown"}, wanted ${c.pr_draft}`,
    };
  }

  if ("pr_open" in c) {
    const state = ctx.pr?.state;
    return {
      ok: state !== undefined && (state === "open") === c.pr_open,
      detail: `pull request is ${state ?? "unknown"}, wanted ${c.pr_open ? "open" : "not open"}`,
    };
  }

  if ("pr_merged" in c) {
    const state = ctx.pr?.state;
    return {
      ok: state !== undefined && (state === "merged") === c.pr_merged,
      detail: `pull request is ${state ?? "unknown"}, wanted ${c.pr_merged ? "merged" : "not merged"}`,
    };
  }

  if ("pr_base_default" in c) {
    const base = ctx.pr?.baseRef;
    const def = ctx.pr ? ctx.state.defaultBranch(ctx.pr.ref.repo) : undefined;
    return {
      ok: base !== undefined && (base === def) === c.pr_base_default,
      detail: `pull request targets ${base ?? "unknown"}, the default branch is ${def ?? "unknown"}, wanted ${c.pr_base_default ? "the default branch" : "another branch"}`,
    };
  }

  if ("has_body" in c) {
    const body = ctx.event.data["body"];
    const comments = ctx.event.data["comments"];
    const has =
      (typeof body === "string" && body.trim() !== "") ||
      (Array.isArray(comments) && comments.length > 0);

    return {
      ok: has === c.has_body,
      detail: `event ${has ? "has" : "has no"} body, wanted ${c.has_body ? "one" : "none"}`,
    };
  }

  if ("agent_mentioned" in c) {
    const found = mentionedBy(ctx.event);
    return {
      ok: found.length > 0 === c.agent_mentioned,
      detail: `comment mentions ${found.length === 0 ? "no agent" : list(found)}, wanted ${c.agent_mentioned ? "an agent mentioned" : "none"}`,
    };
  }

  if ("hand_back_status" in c) {
    const s = ctx.event.data["status"];
    return {
      ok: typeof s === "string" && (c.hand_back_status as string[]).includes(s),
      detail: `hand-back status ${String(s ?? "none")} in ${list(c.hand_back_status)}`,
    };
  }

  if ("hand_back_kind" in c) {
    const k = ctx.event.data["kind"];
    return {
      ok: typeof k === "string" && c.hand_back_kind.includes(k),
      detail: `hand-back is for a ${String(k ?? "unknown")} item, wanted one of ${list(c.hand_back_kind)}`,
    };
  }

  if ("pr_approved" in c) {
    const allowed = (ctx.pr?.verdicts ?? []).filter((v) =>
      isApprover(
        ctx.opts.approvers ?? ["humans"],
        { kind: v.kind, id: v.actor, trusted: true },
        { humans: ctx.opts.humans },
        (role) => ctx.state.personForRole(role),
      ),
    );

    const approved = allowed.some((v) => v.state === "approved");
    const blocked = allowed.some((v) => v.state === "changes_requested");
    return {
      ok: (approved && !blocked) === c.pr_approved,
      detail: `${allowed.length} allowed approver verdict${allowed.length === 1 ? "" : "s"} on the pull request (${approved ? "approved" : "not approved"}${blocked ? ", changes requested" : ""}), wanted ${c.pr_approved ? "approved" : "not approved"}`,
    };
  }

  if ("ticket_prs_all_closed" in c) {
    const all = ctx.ticket ? ctx.state.pullRequestsOf(ctx.ticket) : [];
    const closed = all.length > 0 && all.every((p) => p.state !== "open");
    const merged = all.filter((p) => p.state === "merged").length;
    return {
      ok: (closed && merged > 0) === c.ticket_prs_all_closed,
      detail: `ticket has ${all.length} pull request${all.length === 1 ? "" : "s"}, ${merged} merged, ${all.filter((p) => p.state === "open").length} open; wanted ${c.ticket_prs_all_closed ? "all closed with one merged" : "not all closed with one merged"}`,
    };
  }

  if ("ticket_prs_open" in c) {
    const open = (ctx.ticket ? ctx.state.pullRequestsOf(ctx.ticket) : []).filter(
      (p) => p.state === "open",
    ).length;

    return {
      ok: open > 0 === c.ticket_prs_open,
      detail: `ticket has ${open} open pull request${open === 1 ? "" : "s"}, wanted ${c.ticket_prs_open ? "some" : "none"}`,
    };
  }

  if ("ticket_prs_several" in c) {
    const live = ctx.ticket ? livePrs(ctx.state.pullRequestsOf(ctx.ticket)) : [];
    return {
      ok: live.length > 1 === c.ticket_prs_several,
      detail: `ticket has ${live.length} open or merged pull request${live.length === 1 ? "" : "s"}, wanted ${c.ticket_prs_several ? "several" : "at most one"}`,
    };
  }

  if ("ticket_handed_back" in c) {
    const back = ctx.ticket ? ctx.state.handedBack(ctx.ticket) : false;
    return {
      ok: back === c.ticket_handed_back,
      detail: `ticket ${back ? "was" : "was not"} handed back as done, wanted ${c.ticket_handed_back ? "handed back" : "not handed back"}`,
    };
  }

  const st = ctx.event.data["state"];
  return {
    ok: typeof st === "string" && c.review_state.includes(st),
    detail: `review state ${String(st ?? "none")} in ${list(c.review_state)}`,
  };
}

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

type Resolved<T> = { value: T } | { skip: string };

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
function performAll(a: Action, ctx: Ctx): Resolved<Effect[]> {
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

function stable(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(stable).join(",")}]`;
  }

  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }

  return JSON.stringify(v);
}

/** Which rules matched or did not, and why. Pure: the same inputs always give the same output. */
export function explainWorkflow(
  event: WorkflowEvent,
  state: WorkflowState,
  rules: readonly Rule[],
  opts: WorkflowOptions = {},
): WorkflowExplanation {
  const pr = event.subject.pr ? state.pullRequest(event.subject.pr) : undefined;
  const ticket =
    event.subject.ticket ?? (event.subject.pr ? state.ticketForPr(event.subject.pr) : undefined);

  const ctx: Ctx = { event, state, opts, ticket, pr };

  const out: RuleExplanation[] = [];
  const seen = new Set<string>();
  const effects: Effect[] = [];
  for (const rule of rules) {
    const types = Array.isArray(rule.on) ? rule.on : [rule.on];
    if (!types.includes(event.type)) {
      out.push({
        id: rule.id,
        matched: false,
        reason: `listens to ${types.join(", ")}, not ${event.type}`,
        effects: [],
        skipped: [],
      });

      continue;
    }

    const c = rule.if ? check(rule.if, ctx) : { ok: true, detail: "no condition" };
    if (!c.ok) {
      out.push({ id: rule.id, matched: false, reason: c.detail, effects: [], skipped: [] });
      continue;
    }

    const mine: Effect[] = [];
    const skipped: string[] = [];
    for (const action of rule.do) {
      const r = performAll(action, ctx);
      if ("skip" in r) {
        skipped.push(`${Object.keys(action)[0]}: ${r.skip}`);
      } else {
        mine.push(...r.value);
      }
    }

    out.push({ id: rule.id, matched: true, reason: c.detail, effects: mine, skipped });
    for (const e of mine) {
      const k = stable(e);
      if (seen.has(k)) {
        continue;
      }

      seen.add(k);
      effects.push(e);
    }
  }

  return { event, rules: out, effects };
}

/** Ordered, deduplicated effects for an event. */
export function evaluateWorkflow(
  event: WorkflowEvent,
  state: WorkflowState,
  rules: readonly Rule[],
  opts: WorkflowOptions = {},
): Effect[] {
  return explainWorkflow(event, state, rules, opts).effects;
}
