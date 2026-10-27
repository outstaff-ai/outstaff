import { teamConfigSchema } from "./schema.js";
import { toConfigIssues } from "./issues.js";
import type { ParseResult } from "./types.js";

export function parseTeamConfig(value: unknown): ParseResult {
  const result = teamConfigSchema.safeParse(value);
  if (result.success) {
    return { ok: true, config: result.data };
  }

  return { ok: false, issues: toConfigIssues(result.error) };
}
