import type { RestBranch } from "@outstaff/integration.vcs.github";
import type { Route } from "@outstaff/testing.http";
import type { BranchRules } from "./types.js";

const NOT_PROTECTED = { status: 404, body: { message: "Branch not protected" } };

/** A repository's default branch: its protection summary, its classic protection and the rules of its rulesets. */
export function branchRoutes(
  branch: BranchRules,
  repo: string,
  headOf: (branch: string) => Promise<string | undefined> = async () => undefined,
): Route[] {
  return [
    {
      method: "GET",
      path: `${repo}/branches/:branch`,
      handler: async (r): Promise<RestBranch> => {
        const { protection } = branch;
        const sha = await headOf(r.params["branch"]!);
        return {
          name: r.params["branch"]!,
          ...(sha ? { commit: { sha } } : {}),
          protected: !!protection,
          protection: {
            enabled: !!protection,
            ...(protection?.required_status_checks
              ? { required_status_checks: protection.required_status_checks }
              : {}),
          },
        };
      },
    },
    {
      method: "GET",
      path: `${repo}/branches/:branch/protection`,
      handler: () => branch.protection ?? NOT_PROTECTED,
    },
    {
      method: "GET",
      path: `${repo}/rules/branches/:branch`,
      handler: () => branch.rules,
    },
  ];
}

/** The approving reviews the branch's protection and rulesets ask for: the most any of them asks. */
export function requiredApprovals(branch: BranchRules): number {
  return Math.max(
    branch.protection?.required_pull_request_reviews?.required_approving_review_count ?? 0,
    ...branch.rules.map((r) => r.parameters?.required_approving_review_count ?? 0),
  );
}
