import type { RestBranch } from "@outstaff/integration.vcs.github";
import type { FakeState, Route } from "#/types.js";

const NOT_PROTECTED = { status: 404, body: { message: "Branch not protected" } };

/** The default branch: its protection summary, its classic protection and the rules of its rulesets. */
export function branchRoutes(s: FakeState): Route[] {
  const { repo } = s;
  const root = `/repos/${repo.owner}/${repo.name}`;
  return [
    {
      method: "GET",
      path: `${root}/branches/:branch`,
      handler: (r): RestBranch => {
        const protection = s.branch.protection;
        return {
          name: r.params["branch"]!,
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
      path: `${root}/branches/:branch/protection`,
      handler: () => s.branch.protection ?? NOT_PROTECTED,
    },
    {
      method: "GET",
      path: `${root}/rules/branches/:branch`,
      handler: () => s.branch.rules,
    },
  ];
}
