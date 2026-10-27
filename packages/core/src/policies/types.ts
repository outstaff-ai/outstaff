import type { PolicySwitch, PolicyValue } from "./switches.js";

/** Someone who submitted a review, as the host and the team know them. */
export interface ApproverCandidate {
  kind: "human" | "agent" | "automation";

  /** A human's login on the code host, or an agent's handle. */
  id: string;

  /** A human the team trusts (listed in `humans`, or with write access when it lists none). Ignored for agents. */
  trusted: boolean;
}

/**
 * Where an effective value comes from: the built-in default, the team file, the workflow preset (which has no
 * such rule), or an explicit entry of `workflow.rules`, which wins over a switch.
 */
export type PolicySource = "default" | "team.yaml" | "preset" | "workflow.rules";

export interface PolicyReport {
  switch: PolicySwitch;

  /** What happens now. */
  value: PolicyValue;
  source: PolicySource;

  /** Why the value differs from what `policies` says, if it does. */
  note?: string;
}
