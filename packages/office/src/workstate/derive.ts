import { PortError } from "@outstaff/core";
import type { RepoRef, WorkflowPr } from "@outstaff/core";
import type { WorkstateCore } from "./core.types.js";
import type { CiState, CurrentWork, DocRecord, PrRecord } from "./types.js";

export const TERMINAL = new Set(["done", "canceled"]);

export const isTerminal = (status: string | undefined): boolean =>
  status !== undefined && TERMINAL.has(status);

export const ciOf = (checks: PrRecord["checks"]): CiState => {
  if (checks.length === 0) {
    return "none";
  }

  if (checks.some((c) => c.status === "failure")) {
    return "failure";
  }

  return checks.some((c) => c.status === "pending") ? "pending" : "success";
};

export const notFound = (error: unknown) =>
  error instanceof PortError && error.code === "not_found";

export const toWorkflowPr = (p: PrRecord): WorkflowPr => ({
  ref: p.ref,
  title: p.title,
  ...(p.url ? { url: p.url } : {}),
  headRef: p.headRef,
  baseRef: p.baseRef,
  draft: p.draft,
  state: p.state,
  author: { ...p.author },
  ...(p.verdicts?.length ? { verdicts: p.verdicts } : {}),
});

export const openPrs = (core: WorkstateCore, repo?: RepoRef) =>
  [...core.prs.values()].filter(
    (p) => p.state === "open" && (!repo || core.sameRepo(p.ref.repo, repo)),
  );

export const docOpen = (core: WorkstateCore, rec: DocRecord): boolean => {
  const ticket = rec.ticket ? core.tickets.get(rec.ticket) : undefined;
  if (ticket) {
    return !(ticket.status && TERMINAL.has(ticket.status));
  }

  return core.clock.now().getTime() - Date.parse(rec.touchedAt) < core.retentionMs;
};

export function stackedOn(core: WorkstateCore, repo: RepoRef, branch: string): WorkflowPr[] {
  // Everything above the branch, bottom first.
  const out: PrRecord[] = [];
  const queue = [branch];
  while (queue.length > 0) {
    const base = queue.shift()!;
    for (const p of openPrs(core, repo)) {
      if (p.baseRef === base && !out.includes(p)) {
        out.push(p);
        queue.push(p.headRef);
      }
    }
  }

  return out.map(toWorkflowPr);
}

export function currentWork(core: WorkstateCore, person: string): CurrentWork {
  const mine = [...core.tickets.values()].filter(
    (t) =>
      t.assignee?.kind === "agent" &&
      t.assignee.id === person &&
      !(t.status && TERMINAL.has(t.status)),
  );

  const keys = new Set(mine.map((t) => t.key));
  const prList = openPrs(core).filter(
    (p) => p.author.person === person || (p.ticket !== undefined && keys.has(p.ticket)),
  );

  const refs = (key: string) =>
    prList.filter((p) => p.ticket === key).map((p) => core.prSubject(p.ref));

  return {
    person,
    tickets: mine.map((t) => ({
      key: t.key,
      title: t.title,
      ...(t.status ? { status: t.status } : {}),
      prs: refs(t.key),
    })),
    prs: prList.map((p) => ({
      ref: core.prSubject(p.ref),
      number: p.ref.number,
      title: p.title,
      ...(p.url ? { url: p.url } : {}),
      state: p.state,
      draft: p.draft,
      ci: p.ci,
      mergeable: p.mergeable,
      unresolvedThreads: p.unresolvedThreads,
      ...(p.review ? { review: p.review } : {}),
      ...(p.ticket ? { ticket: p.ticket } : {}),
      ...(p.stackedOn ? { stackedOn: p.stackedOn } : {}),
    })),
  };
}

type WorkPr = CurrentWork["prs"][number];

/** What is worth knowing about an open pull request beside its title. */
function prNotes(p: WorkPr): string[] {
  return [
    p.draft ? "draft" : "",
    `CI ${p.ci}`,
    p.mergeable === "conflicting" ? "conflicts" : "",
    p.unresolvedThreads > 0 ? `${p.unresolvedThreads} unresolved threads` : "",
    p.review ? `review ${p.review}` : "",
    p.ticket ? `for ${p.ticket}` : "",
    p.stackedOn ? `stacked on ${p.stackedOn}` : "",
  ].filter(Boolean);
}

/** A few lines for the agent's session context. */
export function formatCurrentWork(work: CurrentWork): string {
  if (work.tickets.length === 0 && work.prs.length === 0) {
    return `${work.person} has no open tickets or pull requests.`;
  }

  return [
    ...work.tickets.map((t) => `Ticket ${t.key} (${t.status ?? "unknown"}): ${t.title}`),
    ...work.prs.map((p) => `PR ${p.ref}: ${p.title} (${prNotes(p).join(", ")})`),
  ].join("\n");
}
