import { CONFIG_CODES } from "../config/codes.js";
import type { ConfigIssue } from "../config/types.js";
import { presetRules } from "./presets.js";
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_VARIABLES,
  TemplateError,
  templatePlaceholders,
} from "./template.js";
import type { Action, RuleInput, WorkflowConfigShape } from "./types.js";

function templateOf(a: Action): string | undefined {
  if ("comment" in a) {
    return typeof a.comment === "string" ? a.comment : a.comment.template;
  }

  return undefined;
}

const issue = (code: string, message: string, path: (string | number)[]): ConfigIssue => ({
  code,
  message,
  path,
});

const KNOWN_VARIABLES = new Set<string>(TEMPLATE_VARIABLES);

/** Cross-field checks the schema cannot express. */
export function checkWorkflowConfig(wf: WorkflowConfigShape): ConfigIssue[] {
  return [...duplicateStatusNames(wf), ...placeholderIssues(wf), ...ruleIssues(wf)];
}

function duplicateStatusNames(wf: WorkflowConfigShape): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const byName = new Map<string, string>();
  for (const [status, name] of Object.entries(wf.statuses ?? {})) {
    if (name === undefined) {
      continue;
    }

    const key = name.trim().toLowerCase();
    const other = byName.get(key);
    if (other) {
      issues.push(
        issue(
          CONFIG_CODES.workflowDuplicateStatusName,
          `Status name "${name}" is used for both "${other}" and "${status}".`,
          ["workflow", "statuses", status],
        ),
      );
    } else {
      byName.set(key, status);
    }
  }

  return issues;
}

/** Templates that are malformed or use a variable no template can. */
function placeholderIssues(wf: WorkflowConfigShape): ConfigIssue[] {
  return Object.entries(wf.templates ?? {}).flatMap(([id, text]) => {
    try {
      return templatePlaceholders(text)
        .filter((n) => !KNOWN_VARIABLES.has(n))
        .map((n) =>
          issue(
            CONFIG_CODES.workflowUnknownPlaceholder,
            `Template "${id}" uses unknown variable "${n}".`,
            ["workflow", "templates", id],
          ),
        );
    } catch (e) {
      return [
        issue(CONFIG_CODES.workflowUnknownPlaceholder, (e as TemplateError).message, [
          "workflow",
          "templates",
          id,
        ]),
      ];
    }
  });
}

/** Duplicate rule ids, disabled rules the preset lacks and unknown templates. */
function ruleIssues(wf: WorkflowConfigShape): ConfigIssue[] {
  const templates = { ...BUILTIN_TEMPLATES, ...wf.templates };
  const presetIds = new Set(presetRules(wf.preset).map((r) => r.id));
  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  ((wf.rules as RuleInput[] | undefined) ?? []).forEach((r, i) => {
    if (seen.has(r.id)) {
      issues.push(
        issue(CONFIG_CODES.workflowDuplicateRuleId, `Rule id "${r.id}" is used more than once.`, [
          "workflow",
          "rules",
          i,
          "id",
        ]),
      );
    }

    seen.add(r.id);
    if ("disabled" in r && r.disabled === true && !presetIds.has(r.id)) {
      issues.push(
        issue(
          CONFIG_CODES.workflowUnknownRule,
          `Preset "${wf.preset}" has no rule "${r.id}" to disable.`,
          ["workflow", "rules", i, "id"],
        ),
      );
    }

    if ("do" in r) {
      issues.push(...unknownTemplates(r.do, templates, i));
    }
  });

  return issues;
}

function unknownTemplates(
  actions: Action[],
  templates: Record<string, string>,
  rule: number,
): ConfigIssue[] {
  return actions.flatMap((a, j) => {
    const t = templateOf(a);
    return t !== undefined && !(t in templates)
      ? [
          issue(CONFIG_CODES.workflowUnknownTemplate, `Unknown template "${t}".`, [
            "workflow",
            "rules",
            rule,
            "do",
            j,
          ]),
        ]
      : [];
  });
}
