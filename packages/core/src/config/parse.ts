import { teamConfigSchema, type TeamConfig } from "./schema.js";
import { toConfigIssues, type ConfigIssue } from "./issues.js";

export type ParseResult = { ok: true; config: TeamConfig } | { ok: false; issues: ConfigIssue[] };

export function parseTeamConfig(value: unknown): ParseResult {
  const result = teamConfigSchema.safeParse(value);
  if (result.success) {
    return { ok: true, config: result.data };
  }

  return { ok: false, issues: toConfigIssues(result.error) };
}
