import { formatIssue, validateTeam } from "@outstaff/core";
import { catalogIssue, loadCatalogs, roleRegistry } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { issueJson, loadTeam } from "../load.js";
import { table } from "../table.js";

const DEFAULT_TRUST = "default rule: repo writers and full chat-workspace members";

export const team = defineCommand({
  name: "team",
  summary: "Show the resolved team: humans, repos, people and integrations.",
  description:
    "Prints the team as Outstaff sees it after defaults are applied, including each person's repo grants. Roles are checked against the stock catalog plus the team's ejected catalog; exits 1 if the config cannot be loaded or a role is unknown.",
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

    const { config } = loaded;
    const found = loadCatalogs(ctx, config, loaded.source.dir);
    const problems = found.ok
      ? validateTeam(config, {
          roles: roleRegistry(found.catalogs),
          adapters: new Map(),
        }).errors.map(loaded.locate)
      : found.issues.map(catalogIssue);

    if (options.json) {
      const { humans, repos, people, integrations } = config;
      ctx.out(
        `${JSON.stringify({ file: loaded.source.file, team: config.team, humans: humans ?? null, repos, people, integrations, ...(problems.length ? { errors: problems.map(issueJson) } : {}) }, null, 2)}\n`,
      );

      return problems.length === 0 ? 0 : 1;
    }

    const out: string[] = [];
    out.push(`Team: ${config.team.name}${config.team.product ? ` (${config.team.product})` : ""}`);
    if (config.team.description) {
      out.push(config.team.description);
    }

    out.push("", "Humans");
    if (config.humans === undefined) {
      out.push(`  Not listed; ${DEFAULT_TRUST}.`);
    } else {
      out.push(
        ...table(
          ["NAME", "IDENTITIES"],
          config.humans.map((h) => [
            h.name,
            Object.entries(h.identities)
              .map(([k, v]) => `${k}:${v}`)
              .join(", "),
          ]),
        )
          .split("\n")
          .map((l) => `  ${l}`),
      );
    }

    out.push("", "Repos");
    out.push(
      ...table(
        ["NAME", "KIND", "URL", "BRANCH"],
        config.repos.map((r) => [r.name, r.kind, r.url, r.default_branch]),
      )
        .split("\n")
        .map((l) => `  ${l}`),
    );

    out.push("", "People");
    if (config.people.length === 0) {
      out.push("  None yet. Add one with `ost hire`.");
    } else {
      out.push(
        ...table(
          ["HANDLE", "NAME", "ROLE", "MODEL", "GRANTS"],
          config.people.map((p) => [
            p.handle,
            p.name,
            [p.role, ...(p.extends ?? [])].join("+"),
            p.model ?? "default",
            Object.entries(p.repos)
              .map(([k, v]) => `${k}:${v}`)
              .join(", ") || "none",
          ]),
        )
          .split("\n")
          .map((l) => `  ${l}`),
      );
    }

    out.push("", "Integrations");
    out.push(
      ...table(
        ["PORT", "ADAPTER"],
        Object.entries(config.integrations).map(([port, ref]) => [port, ref?.adapter ?? ""]),
      )
        .split("\n")
        .map((l) => `  ${l}`),
    );

    ctx.out(`${out.join("\n")}\n`);
    for (const p of problems) {
      ctx.err(`error    ${formatIssue(p)}\n`);
    }

    return problems.length === 0 ? 0 : 1;
  },
});
