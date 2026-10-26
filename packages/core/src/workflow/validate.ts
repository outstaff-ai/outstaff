import { CONFIG_CODES } from "../config/codes.js";
import type { ConfigIssue } from "../config/issues.js";
import { presetRules, type WorkflowPreset } from "./presets.js";
import type { Action, RuleInput } from "./rules.js";
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_VARIABLES,
  TemplateError,
  templatePlaceholders,
} from "./template.js";

export interface WorkflowConfigShape {
  preset: WorkflowPreset;
  statuses?: Partial<Record<string, string>> | undefined;
  rules?: unknown[] | undefined;
  templates?: Record<string, string> | undefined;
}

function templateOf(a: Action): string | undefined {
  if ("comment" in a) {
    return typeof a.comment === "string" ? a.comment : a.comment.template;
  }

  return undefined;
}

/** Cross-field checks the schema cannot express. */
export function checkWorkflowConfig(wf: WorkflowConfigShape): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (code: string, message: string, path: (string | number)[]) =>
    issues.push({ code, message, path });

  const byName = new Map<string, string>();
  for (const [status, name] of Object.entries(wf.statuses ?? {})) {
    if (name === undefined) {
      continue;
    }

    const key = name.trim().toLowerCase();
    const other = byName.get(key);
    if (other) {
      add(
        CONFIG_CODES.workflowDuplicateStatusName,
        `Status name "${name}" is used for both "${other}" and "${status}".`,
        ["workflow", "statuses", status],
      );
    } else {
      byName.set(key, status);
    }
  }

  const templates = { ...BUILTIN_TEMPLATES, ...wf.templates };
  const known = new Set<string>(TEMPLATE_VARIABLES);
  for (const [id, text] of Object.entries(wf.templates ?? {})) {
    try {
      for (const n of templatePlaceholders(text)) {
        if (!known.has(n)) {
          add(
            CONFIG_CODES.workflowUnknownPlaceholder,
            `Template "${id}" uses unknown variable "${n}".`,
            ["workflow", "templates", id],
          );
        }
      }
    } catch (e) {
      add(CONFIG_CODES.workflowUnknownPlaceholder, (e as TemplateError).message, [
        "workflow",
        "templates",
        id,
      ]);
    }
  }

  const presetIds = new Set(presetRules(wf.preset).map((r) => r.id));
  const seen = new Set<string>();
  (wf.rules as RuleInput[] | undefined)?.forEach((r, i) => {
    if (seen.has(r.id)) {
      add(CONFIG_CODES.workflowDuplicateRuleId, `Rule id "${r.id}" is used more than once.`, [
        "workflow",
        "rules",
        i,
        "id",
      ]);
    }

    seen.add(r.id);
    if ("disabled" in r && r.disabled === true && !presetIds.has(r.id)) {
      add(
        CONFIG_CODES.workflowUnknownRule,
        `Preset "${wf.preset}" has no rule "${r.id}" to disable.`,
        ["workflow", "rules", i, "id"],
      );
    }

    if ("do" in r) {
      r.do.forEach((a, j) => {
        const t = templateOf(a);
        if (t !== undefined && !(t in templates)) {
          add(CONFIG_CODES.workflowUnknownTemplate, `Unknown template "${t}".`, [
            "workflow",
            "rules",
            i,
            "do",
            j,
          ]);
        }
      });
    }
  });

  return issues;
}
