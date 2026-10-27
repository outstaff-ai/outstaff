import {
  PortError,
  type BranchRule,
  type MergeRequirements,
  type RepoRef,
  type Vcs,
} from "@outstaff/core";
import type {
  RestBranch,
  RestBranchProtection,
  RestRepo,
  RestRequiredStatusChecks,
  RestRule,
} from "#/api.types.js";
import { repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

const NO_RULE: BranchRule = { requiredChecks: [], requiredApprovals: 0, upToDate: false };

const PARTIAL =
  "the review and up-to-date settings of the classic branch protection, which need Administration: read on the office App.";

const fromStatusChecks = (checks: RestRequiredStatusChecks | null | undefined): BranchRule => ({
  ...NO_RULE,
  requiredChecks: checks?.contexts ?? [],
  upToDate: checks?.strict ?? false,
});

/** What one ruleset rule asks; rules of other types ask for nothing this read reports. */
const RULE_READERS: Record<string, (p: NonNullable<RestRule["parameters"]>) => BranchRule> = {
  pull_request: (p) => ({ ...NO_RULE, requiredApprovals: p.required_approving_review_count ?? 0 }),
  required_status_checks: (p) => ({
    ...NO_RULE,
    requiredChecks: (p.required_status_checks ?? []).map((c) => c.context),
    upToDate: p.strict_required_status_checks_policy ?? false,
  }),
};

const fromRule = (rule: RestRule): BranchRule =>
  RULE_READERS[rule.type]?.(rule.parameters ?? {}) ?? NO_RULE;

/** The rules add up: every required check, the highest approval count, up to date if any asks. */
function combine(branch: string, rules: BranchRule[]): MergeRequirements {
  return {
    branch,
    requiredChecks: [...new Set(rules.flatMap((r) => r.requiredChecks))],
    requiredApprovals: Math.max(0, ...rules.map((r) => r.requiredApprovals)),
    upToDate: rules.some((r) => r.upToDate),
  };
}

/** Reading what the code host requires before a pull request merges into the default branch. */
export function requirementOperations(c: GithubContext): Pick<Vcs, "mergeRequirements"> {
  const { http, apiToken } = c;

  /**
   * Classic branch protection. Its full read needs Administration: read; without it, the branch's own summary
   * (Contents: read) still gives the required checks, and the rest is reported as not read.
   */
  async function classic(repo: RepoRef, branch: string, token: string) {
    const path = `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`;
    const summary = (await http.request<RestBranch>("GET", path, { token })).data;
    if (!summary.protected) {
      return { rule: NO_RULE };
    }

    try {
      const full = (
        await http.request<RestBranchProtection>("GET", `${path}/protection`, { token })
      ).data;

      return {
        rule: {
          ...fromStatusChecks(full.required_status_checks),
          requiredApprovals:
            full.required_pull_request_reviews?.required_approving_review_count ?? 0,
        },
      };
    } catch (e) {
      if (!(e instanceof PortError && e.code === "forbidden")) {
        throw e;
      }

      return {
        rule: fromStatusChecks(summary.protection?.required_status_checks),
        partial: PARTIAL,
      };
    }
  }

  return {
    async mergeRequirements(repo) {
      const token = await apiToken(repo);
      const branch = (await http.request<RestRepo>("GET", repoPath(repo), { token })).data
        .default_branch;

      const [protection, rules] = await Promise.all([
        classic(repo, branch, token),
        http.paginate<RestRule[], RestRule>(
          `${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`,
          { token, query: { per_page: 100 } },
          (page) => page,
        ),
      ]);

      const out = combine(branch, [protection.rule, ...rules.map(fromRule)]);
      return protection.partial ? { ...out, partial: protection.partial } : out;
    },
  };
}
