import type { TeamConfig } from "#/config/types.js";
import type { DoctorCheck } from "#/ports/adapter.js";
import { parseRepoUrl } from "#/ports/repo.js";
import type { Vcs } from "#/ports/vcs.js";
import type { MergeRequirements } from "#/ports/vcs-merge.js";
import { policyOn } from "#/policies/switches.js";
import { plural } from "./check.js";
import type { MergeGateGap, RepoEntry } from "./types.js";

/** The repos of the team file some person can write to, by name, kind or `*`. */
export function writableRepos(config: Pick<TeamConfig, "repos" | "people">): RepoEntry[] {
  return config.repos.filter((repo) =>
    config.people.some((p) =>
      [repo.name, `kind:${repo.kind}`, "*"].some((key) => p.repos[key] === "write"),
    ),
  );
}

/**
 * The repos whose pull requests agents may merge: `policies.merge.repos`, else every repo an agent can write to.
 * None while `policies.merge.on_approval` is off.
 */
export function mergeRepos(config: TeamConfig): RepoEntry[] {
  if (!policyOn(config.policies, "merge.on_approval")) {
    return [];
  }

  const scope = config.policies?.merge.repos;
  return scope ? config.repos.filter((repo) => scope.includes(repo.name)) : writableRepos(config);
}

/** What the host requires, in words. */
function required(req: MergeRequirements): string {
  const parts = [
    ...(req.requiredChecks.length > 0 ? [`checks ${req.requiredChecks.join(", ")}`] : []),
    ...(req.requiredApprovals > 0 ? [plural(req.requiredApprovals, "approving review")] : []),
  ];

  return parts.length > 0 ? parts.join(" and ") : "no status check and no approving review";
}

/** What is missing, keyed by whether checks and a review are required: the risk and the fix. */
const GAPS: Record<string, MergeGateGap | undefined> = {
  "false,false": {
    risk: "untested and unreviewed",
    fix: "Add a branch protection rule or ruleset on that branch that requires the CI status checks and at least one approving review.",
  },
  "true,false": {
    risk: "unreviewed",
    fix: "Require at least one approving review in a branch protection rule or ruleset on that branch.",
  },
  "false,true": {
    risk: "untested",
    fix: "Require the CI status checks in a branch protection rule or ruleset on that branch.",
  },
};

/**
 * How a repository's merge gate reads, for `ost doctor` and the office's doctor: the code host's rules gate an agent's
 * merge, so neither required checks nor a required review is an error, and only one of them a warning. A read that
 * missed some rules (`partial`) never fails: it warns and says what it could not read.
 */
export function mergeGateCheck(repo: string, req: MergeRequirements): DoctorCheck {
  const name = `Merge gate of ${repo}`;
  const checks = req.requiredChecks.length > 0;
  const review = req.requiredApprovals > 0;
  const note = req.partial ? ` Not read: ${req.partial}` : "";
  const detail = `${req.branch} requires ${required(req)}.${note}`;
  const gap = GAPS[`${checks},${review}`];
  if (!gap) {
    return { name, status: "ok", detail };
  }

  const status = checks || review || req.partial ? "warn" : "fail";
  return {
    name,
    status,
    detail: `${detail} Agents' pull requests can merge ${gap.risk}.`,
    fix: gap.fix,
  };
}

/** Reads the merge requirements of every repo agents may merge and assesses each with `mergeGateCheck`. */
export async function mergeGateChecks(config: TeamConfig, vcs: Vcs): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const repo of mergeRepos(config)) {
    out.push(await repoGateCheck(repo, vcs));
  }

  return out;
}

async function repoGateCheck(repo: RepoEntry, vcs: Vcs): Promise<DoctorCheck> {
  const name = `Merge gate of ${repo.name}`;
  if (!vcs.mergeRequirements) {
    return {
      name,
      status: "warn",
      detail: "The vcs adapter cannot read the repository's merge requirements.",
    };
  }

  try {
    return mergeGateCheck(repo.name, await vcs.mergeRequirements(parseRepoUrl(repo.url)));
  } catch (e) {
    return {
      name,
      status: "warn",
      detail: `The merge requirements could not be read: ${(e as Error).message}`,
      fix: "Check that the office App is installed on the repository.",
    };
  }
}
