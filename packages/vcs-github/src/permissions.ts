import type { CommandRule } from "@outstaff/core";

const METHOD_FLAGS = ["-X", "--method"];
const BODY_FLAGS = ["-f", "-F", "--field", "--raw-field", "--input"];

const deny = (
  id: string,
  subcommand: string[],
  reason: string,
  args?: CommandRule["args"],
): CommandRule => ({
  id,
  program: "gh",
  subcommand,
  ...(args ? { args } : {}),
  effect: "deny",
  reason,
});

/**
 * Rules for the `gh` CLI. Reads work in granted repositories; anything that changes GitHub goes through
 * `ost pr` (which uses the person's own App identity), never through `gh`.
 */
export function githubCommandRules(): CommandRule[] {
  const rules: CommandRule[] = [
    deny("gh.api.method", ["api"], "gh api with a non-GET method mutates; use ost verbs.", [
      { kind: "flag-value", names: METHOD_FLAGS, values: ["GET"], match: "not-in" },
    ]),
    deny("gh.api.body", ["api"], "gh api with a request body mutates; use ost verbs.", [
      { kind: "flag", names: BODY_FLAGS, present: true },
    ]),
    deny("gh.api.graphql", ["api"], "gh api graphql can mutate; use ost verbs.", [
      { kind: "positional", index: 0, pattern: "^/?graphql" },
    ]),
  ];

  for (const verb of ["create", "edit", "merge", "comment"]) {
    rules.push(
      deny(
        `gh.pr.${verb}`,
        ["pr", verb],
        `Pull requests are changed with ost pr, not gh pr ${verb}.`,
      ),
    );
  }

  rules.push({
    id: "gh.api.get",
    program: "gh",
    subcommand: ["api"],
    effect: "allow",
    requiresRepo: "read",
    reason: "Read-only gh api call.",
  });

  for (const verb of ["view", "checks", "diff"]) {
    rules.push({
      id: `gh.pr.${verb}`,
      program: "gh",
      subcommand: ["pr", verb],
      effect: "allow",
      requiresRepo: "read",
      reason: `gh pr ${verb} is read-only.`,
    });
  }

  return rules;
}
