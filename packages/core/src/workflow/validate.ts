import { CONFIG_CODES } from "#/config/codes.js";
import type { ConfigIssue } from "#/config/types.js";

/** Cross-field checks the schema cannot express: no tracker status name stands for two canonical statuses. */
export function checkWorkflowConfig(wf: {
  statuses?: Partial<Record<string, string>> | undefined;
}): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const byName = new Map<string, string>();
  for (const [status, name] of Object.entries(wf.statuses ?? {})) {
    if (name === undefined) {
      continue;
    }

    const key = name.trim().toLowerCase();
    const other = byName.get(key);
    if (other) {
      issues.push({
        code: CONFIG_CODES.workflowDuplicateStatusName,
        message: `Status name "${name}" is used for both "${other}" and "${status}".`,
        path: ["workflow", "statuses", status],
      });
    } else {
      byName.set(key, status);
    }
  }

  return issues;
}
