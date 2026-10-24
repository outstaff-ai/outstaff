import type { CommandRule } from "@outstaff/core";

/**
 * Rules for the `gh` CLI: all denied. Agents hold no GitHub token (only git gets one, through the credential
 * helper), and pull request work goes through `ost pr`, which checks grants and links its results.
 */
export function githubCommandRules(): CommandRule[] {
  return [
    {
      id: "gh.denied",
      program: "gh",
      effect: "deny",
      reason: "The gh CLI is not available to agents; use `ost pr`.",
    },
  ];
}
