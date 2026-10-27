import type { RepoRef } from "../ports/types.js";
import { livePrs } from "./evaluate-check.js";
import type { Ctx } from "./evaluate.types.js";
import type { PrRef, WorkflowPr, WorkflowState } from "./types.js";

const repoName = (r: RepoRef) => `${r.owner}/${r.name}`;
const key = (ref: PrRef): string => `${repoName(ref.repo)}#${ref.number}`;
const byNumber = (a: WorkflowPr, b: WorkflowPr) => a.ref.number - b.ref.number;

/** A pull request as one line of a list: number, title and link. */
const prLine = (p: WorkflowPr) => `#${p.ref.number} ${p.title}${p.url ? ` (${p.url})` : ""}`;

/** The template variables of an event (TEMPLATE_VARIABLES), every one present. */
export function variables(ctx: Ctx): Record<string, string> {
  const stack = ctx.pr ? stackOf(ctx.pr, ctx.state) : [];
  const ticketPrs = ctx.ticket
    ? livePrs(ctx.state.pullRequestsOf(ctx.ticket)).toSorted(byNumber)
    : [];

  return {
    ticket: ctx.ticket ?? "",
    status: (ctx.ticket && ctx.state.ticketStatus(ctx.ticket)) || "",
    "actor.id": ctx.event.actor.id,
    "actor.kind": ctx.event.actor.kind,
    "event.type": ctx.event.type,
    ...prVariables(ctx.pr),
    "ticket.prs": ticketPrs.map((p) => `- ${prLine(p)}`).join("\n"),
    "ticket.prs.count": String(ticketPrs.length),
    stack: stack.map((p, i) => `${i + 1}. ${prLine(p)}`).join("\n"),
    "stack.count": String(stack.length),
  };
}

function prVariables(pr: WorkflowPr | undefined): Record<string, string> {
  if (!pr) {
    return {
      "pr.number": "",
      "pr.title": "",
      "pr.url": "",
      "pr.repo": "",
      "pr.base": "",
      "pr.head": "",
      "pr.author": "",
    };
  }

  return {
    "pr.number": String(pr.ref.number),
    "pr.title": pr.title,
    "pr.url": pr.url ?? "",
    "pr.repo": repoName(pr.ref.repo),
    "pr.base": pr.baseRef,
    "pr.head": pr.headRef,
    "pr.author": pr.author.person ?? pr.author.login,
  };
}

/** The pull request and those stacked on it, level by level, at most 50 levels up. */
function stackOf(pr: WorkflowPr, state: WorkflowState): WorkflowPr[] {
  const out: WorkflowPr[] = [pr];
  const seen = new Set<string>([key(pr.ref)]);
  let level: WorkflowPr[] = [pr];
  for (let depth = 0; depth < 50 && level.length > 0; depth++) {
    level = stackedOn(level, state, seen);
    out.push(...level);
  }

  return out;
}

/** The pull requests based on any of `level` and not yet seen, by number. */
function stackedOn(level: WorkflowPr[], state: WorkflowState, seen: Set<string>): WorkflowPr[] {
  const next: WorkflowPr[] = [];
  for (const above of level.flatMap((p) => state.stackedOn(p.ref.repo, p.headRef))) {
    if (!seen.has(key(above.ref))) {
      seen.add(key(above.ref));
      next.push(above);
    }
  }

  return next.toSorted(byNumber);
}
