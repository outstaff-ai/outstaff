import {
  isApprover,
  parseRepoUrl,
  PortError,
  policyOn,
  vcsAgentLogins,
  type ApproverCandidate,
  type MergeMethod,
  type MergeOptions,
  type PullRequest,
  type PullRequestReview,
  type RepoRef,
  type Vcs,
} from "@outstaff/core";
import type { AgentEnv, MergeVcs } from "./types.js";

const stripBot = (login: string) => login.replace(/\[bot\]$/i, "").toLowerCase();

/** The agent who plays a catalog role, when exactly one does. */
function personForRole(env: AgentEnv, role: string): string | undefined {
  const found = env.team.people.filter((p) => p.role === role);
  return found.length === 1 ? found[0]!.handle : undefined;
}

/**
 * Who a login on the code host is, for the approver check: one of our agents, another bot, or a human. A human is
 * trusted when listed in `humans`, or, when the team lists none, with write access to the repo.
 */
async function candidateOf(
  env: AgentEnv,
  vcs: Vcs,
  repo: RepoRef,
  login: string,
): Promise<ApproverCandidate> {
  const handle = vcsAgentLogins(env.team).get(login.toLowerCase());
  if (handle !== undefined) {
    return { kind: "agent", id: handle, trusted: false };
  }

  if (login.endsWith("[bot]")) {
    return { kind: "automation", id: login, trusted: false };
  }

  if (env.team.humans) {
    const listed = env.team.humans.some(
      (h) => h.identities.vcs?.toLowerCase() === login.toLowerCase(),
    );

    return { kind: "human", id: login, trusted: listed };
  }

  const level = await vcs.permission(repo, login);
  return { kind: "human", id: login, trusted: level === "write" || level === "admin" };
}

/** The latest review of each reviewer that decides something: an approval, a request for changes, or a dismissal. */
function latestVerdicts(reviews: PullRequestReview[]): Map<string, PullRequestReview> {
  const latest = new Map<string, PullRequestReview>();
  for (const r of reviews.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (r.state !== "commented") {
      latest.set(r.author.toLowerCase(), r);
    }
  }

  return latest;
}

export function requireMergeVcs(vcs: Vcs): MergeVcs {
  if (!vcs.reviewState || !vcs.requiredChecks || !vcs.mergeOptions || !vcs.mergePullRequest) {
    throw new PortError("unsupported", "this team's code host cannot merge pull requests");
  }

  return vcs as MergeVcs;
}

/** What an allowed approver's latest review says about the current head. */
type Verdict = "approved" | "stale" | "changes";

/** Whether a login may approve this team's merges (`policies.merge.approvers`). */
type AllowedApprover = (login: string) => Promise<boolean>;

const MERGEABLE_PROBLEMS: Partial<Record<PullRequest["mergeable"], string>> = {
  conflicting: "it conflicts with its base branch",
  unknown: "the host has not worked out whether it is mergeable yet",
};

/**
 * Every condition for merging the caller's own pull request, checked here and not by the model: it is the
 * caller's, open, not a draft, mergeable; an allowed approver approved its current head and no allowed approver
 * has changes requested or a review still pending; the required checks passed. The host still decides last.
 */
export async function checkMergeable(
  env: AgentEnv,
  vcs: MergeVcs,
  repo: RepoRef,
  pr: PullRequest,
): Promise<string[]> {
  const approvers = env.team.policies?.merge.approvers ?? ["humans"];
  const allowed: AllowedApprover = async (login) =>
    isApprover(approvers, await candidateOf(env, vcs, repo, login), env.team, (role) =>
      personForRole(env, role),
    );

  return [
    ...pullRequestProblems(env, pr),
    ...(await reviewProblems(vcs, repo, pr, allowed, approvers)),
    ...checksProblems(await vcs.requiredChecks(repo, pr.number)),
  ];
}

/** Why the pull request itself cannot be merged: not the caller's, not open, a draft, or not mergeable. */
function pullRequestProblems(env: AgentEnv, pr: PullRequest): string[] {
  const problems: string[] = [];
  if (!isOwnPullRequest(env, pr)) {
    problems.push(
      `it is not your pull request (authored by ${pr.author.login}); only its author merges it`,
    );
  }

  if (pr.state !== "open") {
    problems.push(`it is ${pr.state}, not open`);
  }

  if (pr.draft) {
    problems.push("it is a draft");
  }

  const mergeable = MERGEABLE_PROBLEMS[pr.mergeable];
  return mergeable ? [...problems, mergeable] : problems;
}

function isOwnPullRequest(env: AgentEnv, pr: PullRequest): boolean {
  const own = env.team.people.find((p) => p.handle === env.person)?.identities?.vcs;
  return !!own && stripBot(pr.author.login) === stripBot(own);
}

/** Why the reviews do not allow a merge: changes requested, a review pending, or no approval of the head. */
async function reviewProblems(
  vcs: MergeVcs,
  repo: RepoRef,
  pr: PullRequest,
  allowed: AllowedApprover,
  approvers: string[],
): Promise<string[]> {
  const state = await vcs.reviewState(repo, pr.number);
  const verdicts = await allowedVerdicts(state.reviews, allowed, pr.head.sha);
  const pending = await allowedLogins(state.requestedReviewers, allowed);
  const problems: string[] = [];
  if (verdicts.changes.length > 0) {
    problems.push(`${verdicts.changes.join(", ")} requested changes and has not approved since`);
  }

  if (pending.length > 0) {
    problems.push(`a review is still pending from ${pending.join(", ")}`);
  }

  if (verdicts.approved.length === 0) {
    problems.push(
      verdicts.stale.length > 0
        ? `${verdicts.stale.join(", ")} approved an earlier commit, not the current head; ask for a new approval`
        : `no allowed approver (policies.merge.approvers: ${approvers.join(", ")}) has an approving review`,
    );
  }

  return problems;
}

/** The reviewers whose latest verdict counts, grouped by what it says; dismissed reviews and non-approvers drop out. */
async function allowedVerdicts(
  reviews: PullRequestReview[],
  allowed: AllowedApprover,
  headSha: string,
): Promise<Record<Verdict, string[]>> {
  const byVerdict: Record<Verdict, string[]> = { approved: [], stale: [], changes: [] };
  for (const review of latestVerdicts(reviews).values()) {
    if (review.state === "dismissed" || !(await allowed(review.author))) {
      continue;
    }

    byVerdict[verdictOf(review, headSha)].push(review.author);
  }

  return byVerdict;
}

function verdictOf(review: PullRequestReview, headSha: string): Verdict {
  if (review.state === "changes_requested") {
    return "changes";
  }

  return review.commitSha !== undefined && review.commitSha !== headSha ? "stale" : "approved";
}

/** The logins that are allowed approvers, in order, asked one at a time. */
async function allowedLogins(logins: string[], allowed: AllowedApprover): Promise<string[]> {
  const kept: string[] = [];
  for (const login of logins) {
    if (await allowed(login)) {
      kept.push(login);
    }
  }

  return kept;
}

function checksProblems(required: Awaited<ReturnType<MergeVcs["requiredChecks"]>>): string[] {
  const notPassed = required.filter((c) => c.status !== "success" && c.status !== "neutral");
  if (notPassed.length === 0) {
    return [];
  }

  return [
    `required checks have not passed: ${notPassed.map((c) => `${c.name} (${c.status})`).join(", ")}`,
  ];
}

/**
 * How to merge: the configured method, else what the repository has (its merge queue, else a direct method its
 * settings allow). Never a method the repository forbids.
 */
export function chooseMethod(
  configured: MergeMethod | undefined,
  options: MergeOptions,
  where: string,
): MergeMethod {
  if (configured) {
    const ok = configured === "queue" ? options.queue : options.methods.includes(configured);
    if (!ok) {
      throw new PortError(
        "conflict",
        `Not merged: policies.merge.method is ${configured}, but ${where} ${configured === "queue" ? "has no merge queue" : "does not allow it"}. Change the policy or the repository settings; do not merge another way.`,
      );
    }

    return configured;
  }

  if (options.queue) {
    return "queue";
  }

  const direct = options.methods[0];
  if (!direct) {
    throw new PortError(
      "conflict",
      `Not merged: ${where} allows no merge method and has no merge queue.`,
    );
  }

  return direct;
}

export const mergeOn = (env: AgentEnv) => policyOn(env.team.policies, "merge.on_approval");

/** The name in team.yaml of a repo, if the team lists it. */
export function teamRepoName(env: AgentEnv, repo: RepoRef): string | undefined {
  const same = (a: RepoRef) =>
    a.owner.toLowerCase() === repo.owner.toLowerCase() &&
    a.name.toLowerCase() === repo.name.toLowerCase();

  return env.team.repos.find((r) => same(parseRepoUrl(r.url)))?.name;
}
