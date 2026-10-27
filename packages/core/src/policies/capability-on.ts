import type { Capability } from "#/types.js";
import { POLICY_SWITCHES, policyOn, type PolicyConfig } from "./switches.js";

/**
 * Whether the team leaves a capability on: it is off only when a policy switch named like the capability exists and
 * is off (`policies.design.canvas: false`). A capability without such a switch is always on.
 */
export function capabilityOn(policies: PolicyConfig, cap: Capability): boolean {
  return !POLICY_SWITCHES.some((s) => s.path === cap) || policyOn(policies, cap);
}
