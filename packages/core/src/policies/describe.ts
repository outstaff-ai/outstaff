import type { TeamConfig } from "../config/types.js";
import { presetRules } from "../workflow/presets.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";
import { POLICY_SWITCHES, blockedNotify, policyValue } from "./switches.js";
import type { PolicySwitch, PolicyValue } from "./switches.js";
import type { PolicyReport, PolicySource } from "./types.js";

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

type DescribedConfig = Pick<TeamConfig, "policies" | "workflow"> &
  Partial<Pick<TeamConfig, "people">>;

/** What a switch's report depends on besides the switch: the config and the rule ids it knows of. */
type Known = {
  config: DescribedConfig;
  raw: unknown;

  /** The rules of the preset, the rules `workflow.rules` writes, and the rules in force. */
  preset: Set<string>;
  written: Set<string>;
  active: Set<string>;
};

/**
 * Every switch with its effective value and source. `raw` is the `policies` section as written in team.yaml
 * (undefined when absent), which tells a default from a value the team set to the same thing.
 */
export function describePolicies(
  config: DescribedConfig,
  workflow: Pick<ResolvedWorkflow, "rules">,
  raw: unknown,
): PolicyReport[] {
  const known: Known = {
    config,
    raw,
    preset: new Set(presetRules(config.workflow?.preset ?? "kanban").map((r) => r.id)),
    written: new Set((config.workflow?.rules ?? []).map((r) => r.id)),
    active: new Set(workflow.rules.map((r) => r.id)),
  };

  return POLICY_SWITCHES.map((sw) => describeSwitch(sw, known));
}

function describeSwitch(sw: PolicySwitch, known: Known): PolicyReport {
  const configured = policyValue(known.config.policies, sw.path);
  const own = has(known.raw, sw.path) ? "team.yaml" : "default";

  return (
    overriddenByRules(sw, known) ??
    missingFromPreset(sw, configured, known) ??
    withoutPmRole(sw, configured, own, known.config) ?? {
      switch: sw,
      value: configured,
      source: own,
    }
  );
}

/** An entry of `workflow.rules` for one of the switch's rules wins over the switch. */
function overriddenByRules(sw: PolicySwitch, known: Known): PolicyReport | undefined {
  const overridden = (sw.rules ?? []).filter((id) => known.written.has(id));
  if (overridden.length === 0) {
    return undefined;
  }

  const on = overridden.some((id) => known.active.has(id));

  return {
    switch: sw,
    value: on ? onValue(sw) : sw.off,
    source: "workflow.rules",
    note: `workflow.rules has an entry for ${overridden.join(", ")}, which wins over the switch`,
  };
}

/** The value of a switch whose rule is on: its default, or true when the default is off. */
const onValue = (sw: PolicySwitch): PolicyValue => (sw.default === sw.off ? true : sw.default);

/** A rule switch the team turns on does nothing when the preset lacks its rule. */
function missingFromPreset(
  sw: PolicySwitch,
  configured: PolicyValue,
  known: Known,
): PolicyReport | undefined {
  const missing = sw.kind === "rule" ? (sw.rules ?? []).filter((id) => !known.preset.has(id)) : [];
  if (configured === sw.off || missing.length === 0) {
    return undefined;
  }

  return {
    switch: sw,
    value: sw.off,
    source: "preset",
    note: `the ${known.config.workflow?.preset ?? "kanban"} preset has no rule ${missing.join(", ")}`,
  };
}

/** A team without a PM role cannot route blocked work to one, whatever the switch says. */
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
