import {
  formatIssue,
  runtimeOf,
  validateTeam,
  type LocatedIssue,
  type TeamConfig,
} from "@outstaff/core";
import { catalogIssue, loadCatalogs, roleRegistry } from "#/catalogs.js";
import { defineCommand } from "#/define.js";
import { issueJson, loadTeam } from "#/load.js";
import { table } from "#/table.js";
import type { Context, Loaded } from "#/types.js";

const DEFAULT_TRUST = "default rule: repo writers and full chat-workspace members";

type LoadedTeam = Extract<Loaded, { ok: true }>;

/** A table indented under its section heading. */
const indented = (header: string[], rows: string[][]): string[] =>
  table(header, rows)
    .split("\n")
    .map((l) => `  ${l}`);

const pairs = (record: Record<string, string | undefined>): string =>
  Object.entries(record)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");

function headerLines({ team }: TeamConfig): string[] {
  const title = `Team: ${team.name}${team.product ? ` (${team.product})` : ""}`;
  return team.description ? [title, team.description] : [title];
}

function humansLines({ humans }: TeamConfig): string[] {
  if (humans === undefined) {
    return [`  Not listed; ${DEFAULT_TRUST}.`];
  }

  return indented(
    ["NAME", "IDENTITIES"],
    humans.map((h) => [h.name, pairs(h.identities)]),
  );
}

const reposLines = ({ repos }: TeamConfig): string[] =>
  indented(
    ["NAME", "KIND", "URL", "BRANCH"],
    repos.map((r) => [r.name, r.kind, r.url, r.default_branch]),
  );

function peopleLines(config: TeamConfig): string[] {
  const { people } = config;
  if (people.length === 0) {
    return ["  None yet. Add one with `ost hire`."];
  }

  return indented(
    ["HANDLE", "NAME", "ROLE", "RUNTIME", "MODEL", "GRANTS"],
    people.map((p) => [
      p.handle,
      p.name,
      [p.role, ...(p.extends ?? [])].join("+"),
      runtimeOf(config, p).adapter,
      p.model ?? "default",
      pairs(p.repos) || "none",
    ]),
  );
}

const integrationsLines = ({ integrations }: TeamConfig): string[] =>
  indented(
    ["PORT", "ADAPTER"],
    Object.entries(integrations).map(([port, ref]) => [port, ref?.adapter ?? ""]),
  );

/** The team as text: a header, then one section per part of the config. */
const teamText = (config: TeamConfig): string =>
  [
    ...headerLines(config),
    "",
    "Humans",
    ...humansLines(config),
    "",
    "Repos",
    ...reposLines(config),
    "",
    "People",
    ...peopleLines(config),
    "",
    "Integrations",
    ...integrationsLines(config),
  ].join("\n");

/** Catalog errors, or the team's validation errors against the merged catalog. */
function problemsOf(ctx: Context, loaded: LoadedTeam): LocatedIssue[] {
  const found = loadCatalogs(ctx, loaded.config, loaded.source.dir);
  if (!found.ok) {
    return found.issues.map(catalogIssue);
  }

  return validateTeam(loaded.config, {
    roles: roleRegistry(found.catalogs),
    adapters: new Map(),
  }).errors.map(loaded.locate);
}

function teamJson(loaded: LoadedTeam, problems: LocatedIssue[]): string {
  const { config } = loaded;
  const { humans, repos, people, integrations } = config;
  return `${JSON.stringify({ file: loaded.source.file, team: config.team, humans: humans ?? null, repos, people, integrations, ...(problems.length ? { errors: problems.map(issueJson) } : {}) }, null, 2)}\n`;
}

export const team = defineCommand({
  name: "team",
  summary: "Show the resolved team: humans, repos, people and integrations.",
  description:
    "Prints the team as Outstaff sees it after defaults are applied, including each person's runtime (their own or the team's) and repo grants. Roles are checked against the stock catalog plus the team's ejected catalog; exits 1 if the config cannot be loaded or a role is unknown.",
  options: [],
  examples: ["ost team", "ost team --json"],
  exitCodes: [
    "0: the team was printed",
    "1: the config could not be loaded or a role is not in the catalog",
  ],
  async run(ctx, options) {
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const problems = problemsOf(ctx, loaded);
    if (options.json) {
      ctx.out(teamJson(loaded, problems));
    } else {
      ctx.out(`${teamText(loaded.config)}\n`);
      for (const p of problems) {
        ctx.err(`error    ${formatIssue(p)}\n`);
      }
    }

    return problems.length === 0 ? 0 : 1;
  },
});
