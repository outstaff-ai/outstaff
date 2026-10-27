import type { PrVerdict, PullRequest, Vcs } from "@outstaff/core";
import type { PrFacts, PrLive } from "./core.types.js";
import { ciOf } from "./derive.js";
import type { PrRecord } from "./types.js";

/** Checks and review threads of an open pull request, read from the code host. */
export async function readLive(vcs: Vcs, pr: PullRequest): Promise<PrLive> {
  const [found, threads] = await Promise.all([
    vcs.checks(pr.repo, pr.head.sha),
    vcs.reviewThreads(pr.repo, pr.number),
  ]);

  return {
    checks: found.map((c) => ({ name: c.name, status: c.status })),
    links: new Map(
      found.map((c) => [c.name, { url: c.url, ...(c.summary ? { summary: c.summary } : {}) }]),
    ),
    unresolved: threads.filter((t) => !t.resolved).length,
  };
}

/** A finished pull request is not read again: it keeps what was last seen of it. */
export function keptLive(prev: PrRecord | undefined): PrLive {
  return {
    checks: prev?.checks ?? [],
    links: new Map(),
    unresolved: prev?.unresolvedThreads ?? 0,
  };
}

/** A new verdict replaces the same reviewer's earlier one. */
export function mergeVerdicts(
  prev: PrVerdict[] | undefined,
  verdict: PrVerdict | undefined,
): PrVerdict[] | undefined {
  return verdict ? [...(prev ?? []).filter((v) => v.actor !== verdict.actor), verdict] : prev;
}

/** The review state and verdicts, the new ones over those of the previous record. */
function reviews(prev: PrRecord | undefined, facts: PrFacts) {
  const review = facts.review ?? prev?.review;
  const verdicts = mergeVerdicts(prev?.verdicts, facts.verdict);
  return {
    ...(review ? { review } : {}),
    ...(verdicts?.length ? { verdicts } : {}),
  };
}

export function toPrRecord(
  pr: PullRequest,
  prev: PrRecord | undefined,
  facts: PrFacts,
  now: string,
): PrRecord {
  return {
    ref: { repo: pr.repo, number: pr.number },
    title: pr.title,
    url: pr.url,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    draft: pr.draft,
    state: pr.state,
    // A finished pull request has no mergeability worth reporting.
    mergeable: pr.state === "open" ? pr.mergeable : (prev?.mergeable ?? pr.mergeable),
    author: {
      login: pr.author.login,
      kind: pr.author.kind,
      ...(facts.person ? { person: facts.person } : {}),
    },
    checks: facts.checks,
    ci: ciOf(facts.checks),
    unresolvedThreads: facts.unresolved,
    ...reviews(prev, facts),
    ...(facts.ticket ? { ticket: facts.ticket } : {}),
    ...(prev?.stackedOn ? { stackedOn: prev.stackedOn } : {}),
    updatedAt: now,
  };
}

/** The data of a `pr.ci_failed` event: the failing checks, with their links where known. */
export function ciFailure(checks: PrRecord["checks"], links: PrLive["links"]) {
  const failed = checks.filter((c) => c.status === "failure");
  return {
    failing: failed.map((c) => c.name),
    checks: failed.map((c) => ({ name: c.name, ...links.get(c.name) })),
  };
}
