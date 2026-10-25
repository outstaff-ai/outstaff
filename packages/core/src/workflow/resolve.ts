import type { TeamConfig } from "../config/schema.js";
import { POLICY_SWITCHES, policyOn, policyValue, type PolicySwitch } from "../policies/switches.js";
import { presetRules, type WorkflowPreset } from "./presets.js";
import type { Rule, RuleInput } from "./rules.js";
import { createStatusMap, type WorkflowStatusMap } from "./status-map.js";
import { DEFAULT_NEEDS_HUMAN_LABEL, type WorkflowOptions } from "./types.js";

/**
 * Preset order first; a client rule with a preset rule's id replaces it in place,
 * `disabled: true` removes it, and new ids are appended in the order written.
 */
export function mergeRules(preset: readonly Rule[], overrides: readonly RuleInput[] = []): Rule[] {
  const out = [...preset];
  for (const o of overrides) {
    const i = out.findIndex((r) => r.id === o.id);
    if ("disabled" in o && o.disabled === true) {
      if (i >= 0) {
        out.splice(i, 1);
      }

      continue;
    }

    const rule = o as Rule;
    if (i >= 0) {
      out[i] = rule;
    } else {
      out.push(rule);
    }
  }

  return out;
}

/** A preset rule a switch changed or removed, before `workflow.rules` was applied. */
export interface SwitchedRule {
  rule: string;
  on: Rule["on"];
  switch: string;

  /** `removed` when the rule is gone, `edited` when the switch changed what it does. */
  effect: "removed" | "edited";
}

/**
 * Applies the policy switches to a preset: a switch that is off removes the rules it governs, or rewrites them
 * when it says how. `workflow.rules` is applied afterwards, so an explicit rule always wins over a switch.
 */
export function applySwitches(
  preset: readonly Rule[],
  policies: TeamConfig["policies"],
): { rules: Rule[]; switched: SwitchedRule[] } {
  const switched: SwitchedRule[] = [];
  const rules: Rule[] = [];
  for (const rule of preset) {
    const sw: PolicySwitch | undefined = POLICY_SWITCHES.find((s) => s.rules?.includes(rule.id));
    if (!sw || policyValue(policies, sw.path) === sw.default) {
      rules.push(rule);
      continue;
    }

    const next = sw.rewrite ? sw.rewrite(rule, policyValue(policies, sw.path)) : undefined;
    switched.push({
      rule: rule.id,
      on: rule.on,
      switch: sw.path,
      effect: next ? "edited" : "removed",
    });

    if (next) {
      rules.push(next);
    }
  }

  return { rules, switched };
}

export interface ResolvedWorkflow {
  rules: Rule[];

  /** What the switches did to the preset. */
  switched: SwitchedRule[];
  options: WorkflowOptions & Required<Pick<WorkflowOptions, "templates" | "needsHumanLabel">>;
  statuses: WorkflowStatusMap;
}

export function resolveWorkflow(
  config?: TeamConfig["workflow"],
  humans?: TeamConfig["humans"],
  policies?: TeamConfig["policies"],
): ResolvedWorkflow {
  const first = policyOn(policies, "hand_back.fallback") ? humans?.[0] : undefined;
  const fallbackRequester = first && (first.identities.tracker ?? first.name);
  const preset: WorkflowPreset = config?.preset ?? "kanban";
  const { rules, switched } = applySwitches(presetRules(preset), policies);
  return {
    rules: mergeRules(rules, config?.rules as RuleInput[] | undefined),
    switched,
    options: {
      templates: config?.templates ?? {},
      needsHumanLabel: config?.needs_human_label ?? DEFAULT_NEEDS_HUMAN_LABEL,
      ...(fallbackRequester ? { fallbackRequester } : {}),
    },
    statuses: createStatusMap(config?.statuses),
  };
}
