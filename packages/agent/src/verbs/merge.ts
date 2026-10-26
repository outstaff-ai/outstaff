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
  const problems: string[] = [];
  const approvers = env.team.policies?.merge.approvers ?? ["humans"];
  const own = env.team.people.find((p) => p.handle === env.person)?.identities?.vcs;
  if (!own || stripBot(pr.author.login) !== stripBot(own)) {
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

  if (pr.mergeable === "conflicting") {
    problems.push("it conflicts with its base branch");
  } else if (pr.mergeable === "unknown") {
    problems.push("the host has not worked out whether it is mergeable yet");
  }

  const allowed = async (login: string) =>
    isApprover(approvers, await candidateOf(env, vcs, repo, login), env.team, (role) =>
      personForRole(env, role),
    );

  const state = await vcs.reviewState(repo, pr.number);
  const approved: string[] = [];
  const stale: string[] = [];
  const changes: string[] = [];
  for (const review of latestVerdicts(state.reviews).values()) {
    if (review.state === "dismissed" || !(await allowed(review.author))) {
      continue;
    }

    if (review.state === "changes_requested") {
      changes.push(review.author);
    } else if (review.commitSha !== undefined && review.commitSha !== pr.head.sha) {
      stale.push(review.author);
    } else {
      approved.push(review.author);
    }
  }

  if (changes.length > 0) {
    problems.push(`${changes.join(", ")} requested changes and has not approved since`);
  }

  const pending: string[] = [];
  for (const login of state.requestedReviewers) {
    if (await allowed(login)) {
      pending.push(login);
    }
  }

  if (pending.length > 0) {
    problems.push(`a review is still pending from ${pending.join(", ")}`);
  }

  if (approved.length === 0) {
    problems.push(
      stale.length > 0
        ? `${stale.join(", ")} approved an earlier commit, not the current head; ask for a new approval`
        : `no allowed approver (policies.merge.approvers: ${approvers.join(", ")}) has an approving review`,
    );
  }

  const required = await vcs.requiredChecks(repo, pr.number);
  const notPassed = required.filter((c) => c.status !== "success" && c.status !== "neutral");
  if (notPassed.length > 0) {
    problems.push(
      `required checks have not passed: ${notPassed.map((c) => `${c.name} (${c.status})`).join(", ")}`,
    );
  }

  return problems;
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
