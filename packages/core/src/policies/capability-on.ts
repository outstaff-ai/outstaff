import type { Capability } from "#/types.js";
import { POLICY_SWITCHES, policyOn } from "./switches.js";
import type { PolicyConfig } from "./types.js";

/** The switch named like the capability or like one of its parents (`design.canvas` for `design.canvas.read`). */
const switchOf = (cap: Capability) =>
  POLICY_SWITCHES.find((s) => cap === s.path || cap.startsWith(`${s.path}.`));

/**
 * Whether the team leaves a capability on: it is off only when a policy switch named like the capability, or like a
 * parent of it, exists and is off (`policies.design.canvas: false` turns off `design.canvas` and
 * `design.canvas.read`). A capability without such a switch is always on.
 */
export function capabilityOn(policies: PolicyConfig, cap: Capability): boolean {
  const found = switchOf(cap);
  return !found || policyOn(policies, found.path);
}
