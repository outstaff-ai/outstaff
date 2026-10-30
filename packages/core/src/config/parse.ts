import { CONFIG_CODES } from "./codes.js";
import { teamConfigSchema } from "./schema.js";
import { toConfigIssues } from "./issues.js";
import type { ConfigIssue, ParseResult } from "./types.js";

/** A person without a model, named by their handle, with an example; any other issue as it is. */
function missingModel(value: unknown, issue: ConfigIssue): ConfigIssue {
  const [list, i, key] = issue.path;
  if (list !== "people" || key !== "model" || issue.path.length !== 3) {
    return issue;
  }

  // The schema reached people[i].model, so people[i] is an object.
  const person = (value as { people: Record<string, unknown>[] }).people[i as number]!;
  if (person["model"] !== undefined) {
    return issue;
  }

  const handle = person["handle"];
  const who = typeof handle === "string" ? `"${handle}"` : `people[${i}]`;
  return {
    path: issue.path,
    code: CONFIG_CODES.peopleMissingModel,
    message: `Person ${who} has no model. Every person needs one, for example \`model: sonnet\`.`,
  };
}

export function parseTeamConfig(value: unknown): ParseResult {
  const result = teamConfigSchema.safeParse(value);
  if (result.success) {
    return { ok: true, config: result.data };
  }

  return { ok: false, issues: toConfigIssues(result.error).map((i) => missingModel(value, i)) };
}
