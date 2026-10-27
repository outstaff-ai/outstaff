import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "#/define.js";
import { writeFileDeep } from "#/ejected.js";
import { openTeam } from "#/open-team.js";
import type { Context } from "#/types.js";
import { onlyArg } from "./args.js";
import { fromStockRole, templateRole, titleOf } from "./role/files.js";
import type { RoleFiles, RoleOptions } from "./role/types.js";

const TOOLSETS = ["base", "code", "infra"] as const;
const PROFILES = ["readonly", "docs", "code", "infra"] as const;

/** A DNS label: it ends up in file names, branch names and hostnames. */
const DNS_SAFE = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const isOneOf = (list: readonly string[], value: string | undefined): boolean =>
  value === undefined || list.includes(value);

const isSingleLine = (text: string): boolean => text.trim() !== "" && !/[\r\n]/.test(text.trim());

/** Why the name or an option is not valid; undefined when they all are. */
function invalidInput(name: string, o: RoleOptions): string | undefined {
  if (!DNS_SAFE.test(name)) {
    return `"${name}" is not a valid role name: use 1 to 63 lowercase letters, digits and dashes, starting with a letter and not ending with a dash.`;
  }

  if (!isOneOf(PROFILES, o.profile)) {
    return `--profile must be one of ${PROFILES.join(", ")}.`;
  }

  if (!isOneOf(TOOLSETS, o.toolset)) {
    return `--toolset must be one of ${TOOLSETS.join(", ")}.`;
  }

  if (o.title !== undefined && !isSingleLine(o.title)) {
    return "--title must be a single non-empty line.";
  }

  return undefined;
}

/** Why the role cannot be created where it would go; undefined when it can. */
function takenName(
  stockDir: string,
  target: string,
  name: string,
  force: boolean,
): string | undefined {
  if (existsSync(join(stockDir, "roles", name, "role.yaml"))) {
    return `"${name}" is a stock role. Run ost eject ${name} to customize it, or pick another name.`;
  }

  if (existsSync(join(target, "role.yaml")) && !force) {
    return `roles/${name} already exists; pass --force to replace it.`;
  }

  return undefined;
}

/** The files of the new role, or why it cannot be created. */
function roleFiles(
  stockDir: string,
  target: string,
  name: string,
  o: RoleOptions,
): (RoleFiles & { title: string }) | string {
  const taken = takenName(stockDir, target, name, o.force === true);
  if (taken) {
    return taken;
  }

  const title = o.title?.trim() || titleOf(name);
  const files =
    o.from === undefined
      ? templateRole(name, title, o)
      : fromStockRole(stockDir, o.from, name, title, o);

  return typeof files === "string" ? files : { ...files, title };
}

function printCreated(
  ctx: Context,
  json: boolean,
  created: { name: string; title: string; dir: string; target: string },
): void {
  const { name, title, dir, target } = created;
  const files = [`roles/${name}/role.yaml`, `roles/${name}/SKILL.md`];
  if (json) {
    ctx.out(`${JSON.stringify({ name, title, dir: target, files }, null, 2)}\n`);
    return;
  }

  for (const f of files) {
    ctx.out(`created  ${f}\n`);
  }

  ctx.out(
    `Created custom role "${name}" in ${dir}. Edit the files, then set role: ${name} on a person and run ost validate.\n`,
  );
}

export const roleNew = defineCommand({
  name: "new",
  group: "role",
  summary: "Scaffold a custom role in the team's catalog.",
  description:
    "Creates roles/<name>/role.yaml and SKILL.md in the ejected catalog (catalog.path next to the team file, .outstaff/catalog by default). Without --from, both files come from a minimal template with TODO placeholders; with --from <stock-role>, they are copies of that stock role with the name and title replaced. A custom role is not ejected: it is not recorded in .ejected.json, has no stock original, and ost upgrade leaves it alone. People can then use it as their role, and it can be extended by other roles. The name must be DNS-safe (lowercase letters, digits and dashes, starting with a letter, at most 63 characters) and must not be a stock role; to customize a stock role use ost eject. An existing custom role is only replaced with --force.",
  args: "<name>",
  options: [
    { flags: "--from <stock-role>", description: "Start from the text of this stock role." },
    { flags: "--title <title>", description: "Display title; defaults to the name in title case." },
    {
      flags: "--profile <profile>",
      description: `Permission profile: ${PROFILES.join(", ")}. Defaults to docs, or the --from role's.`,
    },
    {
      flags: "--toolset <toolset>",
      description: `Tool bundle: ${TOOLSETS.join(", ")}. Defaults to base, or the --from role's.`,
    },
    { flags: "--force", description: "Replace a custom role that already exists." },
  ],
  examples: [
    "ost role new auditor",
    'ost role new qa --from reviewer --title "QA Engineer"',
    "ost role new data-engineer --profile code --toolset code",
  ],
  exitCodes: [
    "0: the role was created",
    "1: the team could not be loaded, the name is invalid or a stock role, the role exists and --force was not given, or an option is unknown",
  ],
  async run(ctx, options, args) {
    const o = options as RoleOptions;
    const name = onlyArg(args);
    if (name === undefined) {
      ctx.err("error    Give exactly one role name.\n");
      return 1;
    }

    const invalid = invalidInput(name, o);
    if (invalid) {
      ctx.err(`error    ${invalid}\n`);
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { dir, stockDir } = opened.team;
    const target = join(dir, "roles", name);
    const files = roleFiles(stockDir, target, name, o);
    if (typeof files === "string") {
      ctx.err(`error    ${files}\n`);
      return 1;
    }

    writeFileDeep(join(target, "role.yaml"), files.yaml);
    writeFileDeep(join(target, "SKILL.md"), files.skill);
    printCreated(ctx, options.json === true, { name, title: files.title, dir, target });
    return 0;
  },
});
