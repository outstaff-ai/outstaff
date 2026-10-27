import { isApprover } from "#/policies/approvers.js";
import type { ApproverCandidate } from "#/policies/types.js";
import { DEFAULT_NEEDS_HUMAN_LABEL } from "./constants.js";
import type { Check, ConditionChecks, ConditionKey, Ctx } from "./evaluate.types.js";
import type { Condition, ConditionEvent, WorkflowPr } from "./types.js";

/** The agents a comment names, first mention first: the handles the office put in `data.mentions`. */
export const mentionedBy = (event: ConditionEvent): string[] => {
  const found = event.data["mentions"];
  return Array.isArray(found)
    ? [...new Set(found.filter((m): m is string => typeof m === "string" && m !== ""))]
    : [];
};

/** The pull requests that count toward a ticket's share: a closed one that never merged does not. */
export const livePrs = (prs: WorkflowPr[]) => prs.filter((p) => p.state !== "closed");
const list = (xs: readonly string[]) => `[${xs.join(", ")}]`;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Whether a value from the event's data is one of the wanted strings. */
const oneOf = (value: unknown, wanted: readonly string[]) =>
  typeof value === "string" && wanted.includes(value);

const ticketPrs = (ctx: Ctx): WorkflowPr[] =>
  ctx.ticket ? ctx.state.pullRequestsOf(ctx.ticket) : [];

/** Whether someone may approve under the workflow's `approvers` option (any trusted human by default). */
function approves(ctx: Ctx, who: ApproverCandidate): boolean {
  return isApprover(ctx.opts.approvers ?? ["humans"], who, { humans: ctx.opts.humans }, (role) =>
    ctx.state.personForRole(role),
  );
}

export function check(c: Condition, ctx: Ctx): Check {
  const key = CONDITION_KEYS.find((k) => k in c) ?? "review_state";
  const judge = CHECKS[key] as (wanted: unknown, ctx: Ctx) => Check;

  return judge((c as Record<ConditionKey, unknown>)[key], ctx);
}

const CHECKS: ConditionChecks = {
  all: (conditions, ctx) => {
    for (const child of conditions) {
      const r = check(child, ctx);
      if (!r.ok) {
        return r;
      }
    }

    return { ok: true, detail: "all conditions hold" };
  },
  any: (conditions, ctx) => {
    const rs = conditions.map((child) => check(child, ctx));
    const hit = rs.find((r) => r.ok);
    return hit ?? { ok: false, detail: `none of: ${rs.map((r) => r.detail).join("; ")}` };
  },
  not: (condition, ctx) => {
    const r = check(condition, ctx);
    return {
      ok: !r.ok,
      detail: r.ok ? `not (${r.detail})` : `${r.detail}, so not-condition holds`,
    };
  },
  ticket_status: (wanted, ctx) => {
    const s = ctx.ticket ? ctx.state.ticketStatus(ctx.ticket) : undefined;
    const shown = s ?? (ctx.ticket ? "unknown" : "none (no linked ticket)");
    return {
      ok: s !== undefined && wanted.includes(s),
      detail: `ticket status ${shown} in ${list(wanted)}`,
    };
  },
  moved_to: (wanted, ctx) => {
    const to = ctx.event.data["to"];
    return { ok: oneOf(to, wanted), detail: `moved to ${String(to ?? "none")} in ${list(wanted)}` };
  },
  actor_kind: (wanted, ctx) => ({
    ok: ctx.event.actor.kind === wanted,
    detail: `actor is ${ctx.event.actor.kind}, wanted ${wanted}`,
  }),
  assignee_kind: (wanted, ctx) => {
    const kind = (ctx.ticket ? ctx.state.assignee(ctx.ticket) : undefined)?.kind ?? "none";
    return { ok: kind === wanted, detail: `assignee is ${kind}, wanted ${wanted}` };
  },
  has_label: (wanted, ctx) => {
    const label =
      wanted === "$needs_human" ? (ctx.opts.needsHumanLabel ?? DEFAULT_NEEDS_HUMAN_LABEL) : wanted;

    return {
      ok: ctx.ticket !== undefined && ctx.state.hasLabel(ctx.ticket, label),
      detail: `ticket has label "${label}"`,
    };
  },
  pr_author_kind: (wanted, ctx) => {
    const kind = ctx.pr?.author.kind;
    return {
      ok: kind === wanted,
      detail: `pull request author is ${kind ?? "unknown"}, wanted ${wanted}`,
    };
  },
  approver: (wanted, ctx) => {
    const { kind, id } = ctx.event.actor;
    const ok =
      approves(ctx, { kind, id, trusted: ctx.event.data["untrusted"] !== true }) === wanted;

    return { ok, detail: `actor ${id} is ${wanted ? "" : "not "}an allowed approver` };
  },
  pr_draft: (wanted, ctx) => {
    const draft = ctx.pr?.draft;
    return {
      ok: draft !== undefined && draft === wanted,
      detail: `pull request draft is ${draft ?? "unknown"}, wanted ${wanted}`,
    };
  },
  pr_open: (wanted, ctx) => {
    const state = ctx.pr?.state;
    return {
      ok: state !== undefined && (state === "open") === wanted,
      detail: `pull request is ${state ?? "unknown"}, wanted ${wanted ? "open" : "not open"}`,
    };
  },
  pr_merged: (wanted, ctx) => {
    const state = ctx.pr?.state;
    return {
      ok: state !== undefined && (state === "merged") === wanted,
      detail: `pull request is ${state ?? "unknown"}, wanted ${wanted ? "merged" : "not merged"}`,
    };
  },
  pr_base_default: (wanted, ctx) => {
    const base = ctx.pr?.baseRef;
    const def = ctx.pr ? ctx.state.defaultBranch(ctx.pr.ref.repo) : undefined;
    return {
      ok: base !== undefined && (base === def) === wanted,
      detail: `pull request targets ${base ?? "unknown"}, the default branch is ${def ?? "unknown"}, wanted ${wanted ? "the default branch" : "another branch"}`,
    };
  },
  has_body: (wanted, ctx) => {
    const has = hasBody(ctx.event);
    return {
      ok: has === wanted,
      detail: `event ${has ? "has" : "has no"} body, wanted ${wanted ? "one" : "none"}`,
    };
  },
  agent_mentioned: (wanted, ctx) => {
    const found = mentionedBy(ctx.event);
    return {
      ok: found.length > 0 === wanted,
      detail: `comment mentions ${found.length === 0 ? "no agent" : list(found)}, wanted ${wanted ? "an agent mentioned" : "none"}`,
    };
  },
  hand_back_status: (wanted, ctx) => {
    const s = ctx.event.data["status"];
    return {
      ok: oneOf(s, wanted),
      detail: `hand-back status ${String(s ?? "none")} in ${list(wanted)}`,
    };
  },
  hand_back_kind: (wanted, ctx) => {
    const k = ctx.event.data["kind"];
    return {
      ok: oneOf(k, wanted),
      detail: `hand-back is for a ${String(k ?? "unknown")} item, wanted one of ${list(wanted)}`,
    };
  },
  pr_approved: (wanted, ctx) => {
    const allowed = (ctx.pr?.verdicts ?? []).filter((v) =>
      approves(ctx, { kind: v.kind, id: v.actor, trusted: true }),
    );

    const approved = allowed.some((v) => v.state === "approved");
    const blocked = allowed.some((v) => v.state === "changes_requested");
    return {
      ok: (approved && !blocked) === wanted,
      detail: `${plural(allowed.length, "allowed approver verdict")} on the pull request (${approved ? "approved" : "not approved"}${blocked ? ", changes requested" : ""}), wanted ${wanted ? "approved" : "not approved"}`,
    };
  },
  ticket_prs_all_closed: (wanted, ctx) => {
    const all = ticketPrs(ctx);
    const closed = all.length > 0 && all.every((p) => p.state !== "open");
    const merged = all.filter((p) => p.state === "merged").length;
    const open = all.filter((p) => p.state === "open").length;
    return {
      ok: (closed && merged > 0) === wanted,
      detail: `ticket has ${plural(all.length, "pull request")}, ${merged} merged, ${open} open; wanted ${wanted ? "all closed with one merged" : "not all closed with one merged"}`,
    };
  },
  ticket_prs_open: (wanted, ctx) => {
    const open = ticketPrs(ctx).filter((p) => p.state === "open").length;
    return {
      ok: open > 0 === wanted,
      detail: `ticket has ${plural(open, "open pull request")}, wanted ${wanted ? "some" : "none"}`,
    };
  },
  ticket_prs_several: (wanted, ctx) => {
    const live = livePrs(ticketPrs(ctx));
    return {
      ok: live.length > 1 === wanted,
      detail: `ticket has ${plural(live.length, "open or merged pull request")}, wanted ${wanted ? "several" : "at most one"}`,
    };
  },
  ticket_handed_back: (wanted, ctx) => {
    const back = ctx.ticket ? ctx.state.handedBack(ctx.ticket) : false;
    return {
      ok: back === wanted,
      detail: `ticket ${back ? "was" : "was not"} handed back as done, wanted ${wanted ? "handed back" : "not handed back"}`,
    };
  },
  review_state: (wanted, ctx) => {
    const st = ctx.event.data["state"];
    return {
      ok: oneOf(st, wanted),
      detail: `review state ${String(st ?? "none")} in ${list(wanted)}`,
    };
  },
};

/** Condition names in the order they are tried. */
const CONDITION_KEYS = Object.keys(CHECKS) as ConditionKey[];

/** Whether the event carries text: a non-blank body, or comments. */
function hasBody(event: ConditionEvent): boolean {
  const body = event.data["body"];
  const comments = event.data["comments"];

  return (
    (typeof body === "string" && body.trim() !== "") ||
    (Array.isArray(comments) && comments.length > 0)
  );
}
