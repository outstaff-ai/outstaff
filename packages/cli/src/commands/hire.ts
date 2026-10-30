import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ConfigSource, TeamConfig } from "@outstaff/core";
import { catalogIssue, loadCatalogs } from "#/catalogs.js";
import { defineCommand } from "#/define.js";
import { onlyArg } from "./args.js";
import { openTeam } from "#/open-team.js";
import { projectRoot, secretsLocation } from "#/project.js";
import { addPerson } from "#/teamfile.js";
import type { Context, NewPerson, SecretsLocation } from "#/types.js";
import { approved } from "./hire/approve.js";
import { finishHire } from "./hire/finish.js";
import { choosePerson } from "./hire/person.js";
import type { HireOptions } from "./hire/types.js";
import { missingIgnores } from "./setup/ignores.js";

/** The role in the merged catalog; undefined (after printing why) when the catalogs fail or it is unknown. */
function findRole(ctx: Context, config: TeamConfig, teamDir: string, role: string) {
  const found = loadCatalogs(ctx, config, teamDir);
  if (!found.ok) {
    for (const i of found.issues) {
      ctx.err(`error    ${catalogIssue(i).message}\n`);
    }

    return undefined;
  }

  const roles = { ...found.catalogs.stock.roles, ...found.catalogs.ejected?.roles };
  const roleDef = roles[role];
  if (!roleDef) {
    ctx.err(
      `error    No role "${role}". Roles: ${Object.keys(roles).toSorted().join(", ")}. Create one with \`ost role new\`.\n`,
    );
  }

  return roleDef;
}

/** The project directory to write the person's files into: --out, or the team file's project root. */
const projectDir = (ctx: Context, options: HireOptions, source: ConfigSource): string =>
  resolve(ctx.cwd, options.out ?? projectRoot(ctx, source));

/** Whether git ignores the person's secret files; prints what to add to .gitignore when not. */
function ignoresSecrets(
  ctx: Context,
  out: string,
  handle: string,
  secrets: SecretsLocation,
): boolean {
  const missing = missingIgnores(out, join(".outstaff", "people", handle, ".env"), secrets);
  if (missing.length > 0) {
    ctx.err(
      `error    Nothing was written: these would not be ignored by git, so real secrets could be committed.\nAdd to .gitignore and run again:\n${missing.map((m) => `  ${m}`).join("\n")}\n`,
    );
  }

  return missing.length === 0;
}

/** Adds the person to the team file; false (after printing why) when it cannot be edited. */
function addToTeamFile(ctx: Context, file: string, person: NewPerson): boolean {
  try {
    writeFileSync(file, addPerson(readFileSync(file, "utf8"), person));
    return true;
  } catch (e) {
    ctx.err(`error    Cannot edit ${file}: ${(e as Error).message}\n`);
    return false;
  }
}

export const hire = defineCommand<HireOptions>({
  name: "hire",
  summary: "Add a person to the team and prepare them to start.",
  description:
    "Adds one person with the given role (stock or custom) to `people` in the team file, keeping its comments and quoting. Anything not given is generated: the name from a small built-in list of neutral names, the handle from the name (a DNS label, made unique with a numeric suffix), the pronouns they/them, the repo grants (write on the primary repository for code roles and on the infra repository for infra roles, read everywhere else) and the avatar seed (the handle). The model has no default: give it with --model. In a terminal it asks about each generated value and the model, shows a summary and asks to confirm; without a terminal it needs --yes. Then it renders the avatar to `.outstaff/people/<handle>/avatar.png|svg` when the team configures an avatars adapter and the avatar is not a URL, does what `ost setup <handle>` does, prints what is left to do by hand (the person's identities in the team file, the compose service or the Kubernetes folder to add) and runs `ost validate`. Nothing is created in GitHub, the chat workspace or the tracker.",
  args: "<role>",
  options: [
    { flags: "--name <name>", description: "Display name. Generated when omitted." },
    {
      flags: "--handle <handle>",
      description:
        "Handle (lowercase letters, digits and dashes, at most 30). Derived from the name when omitted.",
    },
    { flags: "--pronouns <pronouns>", description: "Pronouns. Asked for, default they/them." },
    {
      flags: "--model <model>",
      description:
        "LLM model the person runs on, for example sonnet. Required: asked for in a terminal, needed with --yes.",
    },
    {
      flags: "--avatar <seed|url>",
      description: "Avatar seed, or an https image URL. Defaults to the handle as the seed.",
    },
    {
      flags: "--repos <grants>",
      description:
        'Repo grants as "repo=read|write" separated by commas, for example "shop=write,*=read". Defaults by role.',
    },
    { flags: "--yes", description: "Do not ask to confirm; write what was given or generated." },
    {
      flags: "--out <dir>",
      description:
        "Project directory to write `.outstaff/people/<handle>/...` into. Defaults to the project root of the team file.",
    },
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of the new person's secret files, for the layout hint. Defaults to OUTSTAFF_SECRETS_DIR, then .outstaff/secrets/<handle> next to the team file.",
    },
  ],
  examples: [
    "ost hire developer --model sonnet",
    'ost hire reviewer --name "Ines Varga" --pronouns she/her --model sonnet --yes',
    'ost hire developer --model opus --repos "shop=write,*=read" --avatar sam --yes --json',
  ],
  exitCodes: [
    "0: the person was added and the team file validates",
    "1: the team could not be loaded, the role or an option is invalid, the person was not confirmed, the git ignore rules for setup are missing, or the team file has errors after the change",
  ],
  async run(ctx, options, args) {
    const role = onlyArg(args);
    if (role === undefined) {
      ctx.err("error    Give exactly one role.\n");
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { config, source } = opened.team;
    const roleDef = findRole(ctx, config, source.dir, role);
    if (!roleDef) {
      return 1;
    }

    const chosen = await choosePerson(ctx, options, config, role, roleDef.permissions);
    if (typeof chosen === "number") {
      return chosen;
    }

    const out = projectDir(ctx, options, source);
    const secrets = secretsLocation(ctx, options, out, chosen.handle);
    if (!(await approved(ctx, options, chosen))) {
      return 1;
    }

    if (!ignoresSecrets(ctx, out, chosen.handle, secrets)) {
      return 1;
    }

    if (!addToTeamFile(ctx, source.file, chosen.person)) {
      return 1;
    }

    const hired = { chosen, config, file: source.file, out, secretsDir: secrets.dir };
    return finishHire(ctx, options, hired);
  },
});
