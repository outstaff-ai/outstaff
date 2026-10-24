import type { TeamConfig } from "../config/schema.js";
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

export interface ResolvedWorkflow {
  rules: Rule[];
  options: WorkflowOptions & Required<Pick<WorkflowOptions, "templates" | "needsHumanLabel">>;
  statuses: WorkflowStatusMap;
}

export function resolveWorkflow(
  config?: TeamConfig["workflow"],
  humans?: TeamConfig["humans"],
): ResolvedWorkflow {
  const first = humans?.[0];
  const fallbackRequester = first && (first.identities.tracker ?? first.name);
  const preset: WorkflowPreset = config?.preset ?? "kanban";
  return {
    rules: mergeRules(presetRules(preset), config?.rules as RuleInput[] | undefined),
    options: {
      templates: config?.templates ?? {},
      needsHumanLabel: config?.needs_human_label ?? DEFAULT_NEEDS_HUMAN_LABEL,
      ...(fallbackRequester ? { fallbackRequester } : {}),
    },
    statuses: createStatusMap(config?.statuses),
  };
}
