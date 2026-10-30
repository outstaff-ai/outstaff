import type { TeamConfig } from "#/config/types.js";
import { POLICY_SWITCHES, blockedNotify, policyValue } from "./switches.js";
import type { PolicyReport, PolicySource, PolicySwitch, PolicyValue } from "./types.js";

const has = (raw: unknown, path: string): boolean => {
  let node = raw;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || !(key in node)) {
      return false;
    }

    node = (node as Record<string, unknown>)[key];
  }

  return true;
};

type DescribedConfig = Pick<TeamConfig, "policies"> & Partial<Pick<TeamConfig, "people">>;

/**
 * Every switch with its effective value and source. `raw` is the `policies` section as written in team.yaml
 * (undefined when absent), which tells a default from a value the team set to the same thing.
 */
export function describePolicies(config: DescribedConfig, raw: unknown): PolicyReport[] {
  return POLICY_SWITCHES.map((sw) => {
    const configured = policyValue(config.policies, sw.path);
    const own = has(raw, sw.path) ? "team.yaml" : "default";
    return (
      withoutPmRole(sw, configured, own, config) ?? { switch: sw, value: configured, source: own }
    );
  });
}

/** A team without a PM role cannot leave blocked work to one, whatever the switch says. */
function withoutPmRole(
  sw: PolicySwitch,
  configured: PolicyValue,
  own: PolicySource,
  config: DescribedConfig,
): PolicyReport | undefined {
  if (sw.path !== "hand_back.blocked_notify" || !config.people) {
    return undefined;
  }

  const effective = blockedNotify({ people: config.people, policies: config.policies });

  return effective === configured
    ? undefined
    : { switch: sw, value: effective, source: own, note: "no pm role on the team" };
}
