import type { ArgPredicate, CommandRule } from "@outstaff/core";

/**
 * Options of gh that take the next word as their value, so a rule reads the command exactly: the endpoint of
 * `gh api -H "Accept: x" graphql` is `graphql`, not the header.
 */
const VALUED = [
  "-R",
  "--repo",
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
];

const BY_APP = "the App's Actions permission decides whether it may.";

/** What an agent may run of gh: reading runs, workflows and pull requests, re-running and dispatching CI. */
const ALLOWED: [string[], string][] = [
  [["run", "view"], "Reads a workflow run or its logs."],
  [["run", "list"], "Lists workflow runs."],
  [["run", "watch"], "Follows a workflow run."],
  [["run", "rerun"], `Re-runs a workflow run; ${BY_APP}`],
  [["run", "cancel"], `Cancels a workflow run; ${BY_APP}`],
  [["run", "download"], "Downloads a run's artefacts."],
  [["workflow", "run"], `Dispatches a workflow; ${BY_APP}`],
  [["workflow", "view"], "Reads a workflow."],
  [["workflow", "list"], "Lists workflows."],
  [["pr", "view"], "Reads a pull request."],
  [["pr", "checks"], "Reads a pull request's checks."],
  [["pr", "diff"], "Reads a pull request's diff."],
  [["pr", "list"], "Lists pull requests."],
  [["actions-lock"], "Writes the repository's Actions lockfile."],
  [["api"], "Reads the REST API (GET only)."],
];

const METHOD = ["-X", "--method"];
const FIELDS = ["-f", "--raw-field", "-F", "--field", "--input"];

/** What an agent never runs of gh, whatever else allows it. */
const DENIED: { id: string; subcommand: string[]; args?: ArgPredicate[]; reason: string }[] = [
  {
    id: "gh.pr-merge",
    subcommand: ["pr", "merge"],
    reason:
      "Never merge with gh: merging goes through `ost pr merge`, which checks the approvals and the required checks.",
  },
  {
    id: "gh.pr-approve",
    subcommand: ["pr", "review"],
    args: [{ kind: "flag", names: ["--approve", "-a"], present: true }],
    reason: "Approving with gh is refused; reviews go through `ost pr review`.",
  },
  {
    id: "gh.repo-delete",
    subcommand: ["repo", "delete"],
    reason: "Deleting a repository is a human's call.",
  },
  {
    id: "gh.repo-edit",
    subcommand: ["repo", "edit"],
    reason: "A repository's settings are a human's call.",
  },
  {
    id: "gh.secret",
    subcommand: ["secret"],
    reason: "Secrets are a human's call; agents neither read nor set them.",
  },
  {
    id: "gh.api-method",
    subcommand: ["api"],
    args: [{ kind: "flag-value", names: METHOD, values: ["GET"], match: "not-in" }],
    reason: "gh api is read-only here (GET only). Changes go through the `ost` verbs or a human.",
  },
  {
    id: "gh.api-fields",
    subcommand: ["api"],
    args: [
      { kind: "flag", names: FIELDS, present: true },
      { kind: "flag", names: METHOD, present: false },
    ],
    reason:
      "gh api sends fields as a POST: add -X GET to read with them as query parameters (gh api is read-only here).",
  },
  {
    id: "gh.api-graphql",
    subcommand: ["api"],
    args: [{ kind: "positional", index: 0, pattern: "^graphql$" }],
    reason:
      "gh api graphql can change things and is refused; read the REST API with gh api instead.",
  },
];

const rule = (
  id: string,
  effect: CommandRule["effect"],
  subcommand: string[],
  reason: string,
  args?: ArgPredicate[],
): CommandRule => ({
  id,
  program: "gh",
  subcommand,
  ...(args ? { args } : {}),
  effect,
  reason,
  valuedOptions: VALUED,
});

/**
 * Rules for the `gh` CLI. Agents run it through a wrapper that gives each call a short-lived token for one team
 * repository; these rules keep it to reading and to CI runs, and the App's permissions stay the hard limit. Pull
 * request work goes through `ost pr`, which checks grants and links its results.
 */
export function githubCommandRules(): CommandRule[] {
  return [
    ...ALLOWED.map(([sub, reason]) => rule(`gh.allow.${sub.join(".")}`, "allow", sub, reason)),
    ...DENIED.map(({ id, subcommand, args, reason }) => rule(id, "deny", subcommand, reason, args)),
  ];
}
