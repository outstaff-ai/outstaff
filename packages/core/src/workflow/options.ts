import type { TeamConfig } from "#/config/types.js";
import { policyOn } from "#/policies/switches.js";
import { DEFAULT_NEEDS_HUMAN_LABEL } from "./constants.js";
import type { WorkflowOptions } from "./types.js";

type Team = Pick<TeamConfig, "workflow" | "humans" | "policies">;

/** The first listed human's tracker identity (else name), unless `policies.hand_back.fallback` is none. */
function fallbackRequester(team: Team): string | undefined {
  const first = policyOn(team.policies, "hand_back.fallback") ? team.humans?.[0] : undefined;
  return first && (first.identities.tracker ?? first.name);
}

/**
 * What conditions and assignments read of the team: the needs-human label, who approves a merge, the humans, and who
 * a ticket goes back to when no requester is known (the first listed human, unless `policies.hand_back.fallback` is
 * none).
 */
export function workflowOptions(
  team: Team,
): WorkflowOptions & Required<Pick<WorkflowOptions, "needsHumanLabel" | "approvers">> {
  const fallback = fallbackRequester(team);
  return {
    needsHumanLabel: team.workflow?.needs_human_label ?? DEFAULT_NEEDS_HUMAN_LABEL,
    approvers: team.policies?.merge.approvers ?? ["humans"],
    ...(team.humans ? { humans: team.humans } : {}),
    ...(fallback ? { fallbackRequester: fallback } : {}),
  };
}
