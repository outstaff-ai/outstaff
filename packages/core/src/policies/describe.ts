import type { TeamConfig } from "../config/schema.js";
import { presetRules } from "../workflow/presets.js";
import type { ResolvedWorkflow } from "../workflow/resolve.js";
import { POLICY_SWITCHES, policyValue, type PolicySwitch, type PolicyValue } from "./switches.js";

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

/**
 * Every switch with its effective value and source. `raw` is the `policies` section as written in team.yaml
 * (undefined when absent), which tells a default from a value the team set to the same thing.
 */
export function describePolicies(
  config: Pick<TeamConfig, "policies" | "workflow">,
  workflow: Pick<ResolvedWorkflow, "rules">,
  raw: unknown,
): PolicyReport[] {
  const preset = new Set(presetRules(config.workflow?.preset ?? "kanban").map((r) => r.id));
  const written = new Set((config.workflow?.rules ?? []).map((r) => r.id));
  const active = new Set(workflow.rules.map((r) => r.id));
  return POLICY_SWITCHES.map((sw) => {
    const configured = policyValue(config.policies, sw.path);
    const explicit = has(raw, sw.path);
    const own = explicit ? "team.yaml" : "default";
    const ids = sw.rules ?? [];
    const overridden = ids.filter((id) => written.has(id));
    if (overridden.length > 0) {
      const on = overridden.some((id) => active.has(id));
      return {
        switch: sw,
        value: on ? sw.default : sw.off,
        source: "workflow.rules",
        note: `workflow.rules has an entry for ${overridden.join(", ")}, which wins over the switch`,
      };
    }

    const missing = ids.filter((id) => !preset.has(id));
    if (configured !== sw.off && missing.length > 0) {
      return {
        switch: sw,
        value: sw.off,
        source: "preset",
        note: `the ${config.workflow?.preset ?? "kanban"} preset has no rule ${missing.join(", ")}`,
      };
    }

    return { switch: sw, value: configured, source: own };
  });
}
