import { CAPABILITY_PORT } from "#/capabilities.js";
import { POLICY_SWITCHES, policyOn, policyValue } from "#/policies/switches.js";
import type { PolicySwitch } from "#/policies/types.js";
import type { AdapterInfo, ConfigWarning, TeamConfig } from "./types.js";
import { LACKING } from "./lacking.js";
import { adapterKey } from "./validate-capabilities.js";
import type { TeamCheck } from "./validate.types.js";
import { WARNING_CODES } from "./warning-codes.js";

/** Switches that are on but cannot do anything with the configured adapter. */
export function idleSwitches(c: TeamCheck): ConfigWarning[] {
  const known = c.ctx.adapterCapabilities ?? c.ctx.adapters;

  return POLICY_SWITCHES.flatMap((sw) => idleSwitch(c.config, known, sw));
}

/** Without the port a switch needs there is nothing to act on, so only a configured adapter lacking it counts. */
function idleSwitch(
  config: TeamConfig,
  known: Map<string, AdapterInfo>,
  sw: PolicySwitch,
): ConfigWarning[] {
  const cap = sw.needs;
  if (!cap || !policyOn(config.policies, sw.path)) {
    return [];
  }

  const port = CAPABILITY_PORT[cap];
  const ref = config.integrations[port];
  const info = ref && known.get(adapterKey(port, ref.adapter));
  if (!ref || !info || info.capabilities.includes(cap)) {
    return [];
  }

  return [
    {
      path: ["policies", ...sw.path.split(".")],
      code: WARNING_CODES.policyCapabilityMissing,
      message: `policies.${sw.path} is ${String(policyValue(config.policies, sw.path))}, but the ${port} adapter "${ref.adapter}" does not provide ${cap}.`,
      consequence: `policies.${sw.path} does nothing: the ${port} adapter cannot ${LACKING[cap]}; set it to ${String(sw.off)} to silence this.`,
    },
  ];
}
