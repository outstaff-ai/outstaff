import { isApprover } from "../policies/approvers.js";
import { DEFAULT_NEEDS_HUMAN_LABEL } from "./constants.js";
import type { Check, Ctx } from "./evaluate.types.js";
import type { Condition, WorkflowEvent, WorkflowPr } from "./types.js";

/** The agents a comment names, first mention first: the handles the office put in `data.mentions`. */
export const mentionedBy = (event: WorkflowEvent): string[] => {
  const found = event.data["mentions"];
  return Array.isArray(found)
    ? [...new Set(found.filter((m): m is string => typeof m === "string" && m !== ""))]
    : [];
};

/** The pull requests that count toward a ticket's share: a closed one that never merged does not. */
export const livePrs = (prs: WorkflowPr[]) => prs.filter((p) => p.state !== "closed");
const list = (xs: readonly string[]) => `[${xs.join(", ")}]`;

export function check(c: Condition, ctx: Ctx): Check {
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
