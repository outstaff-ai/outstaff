import { join, resolve } from "node:path";
import {
  configuredAdapters,
  formatIssue,
  type AdapterRegistry,
  type TeamConfig,
} from "@outstaff/core";
import { defineCommand } from "#/define.js";
import { loadTeam } from "#/load.js";
import { projectRoot, secretsLocation } from "#/project.js";
import type { Context, GlobalOptions, Loaded, SecretsLocation } from "#/types.js";
import { runDerive } from "./setup/derive.js";
import { missingIgnores } from "./setup/ignores.js";
import { shippedRegistry } from "./setup/registry.js";
import { writeTemplate } from "./setup/template-step.js";
import type { SetupOptions, SetupPlan } from "./setup/types.js";
import type { Scope } from "./types.js";

type LoadedTeam = Extract<Loaded, { ok: true }>;

const scopeOf = (target: string): Scope => (target === "office" ? "office" : "person");

/** The scope's `.env` file, relative to the project directory. */
const envFileOf = (scope: Scope, target: string): string =>
  scope === "office"
    ? join(".outstaff", "office", ".env")
    : join(".outstaff", "people", target, ".env");

/** The adapters a test passed in, or every adapter this build ships. */
const registryOf = async (ctx: Context): Promise<AdapterRegistry> =>
  ctx.registry && ctx.registry.list().length > 0 ? ctx.registry : shippedRegistry();

/** The person the target names; undefined for the office, or (after printing why) when unknown. */
function findPerson(ctx: Context, config: TeamConfig, target: string) {
  const person = config.people.find((p) => p.handle === target);
  if (!person) {
    ctx.err(
      `Unknown person "${target}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}. Use "office" for the office.\n`,
    );
  }

  return person;
}

/** Whether git ignores the scope's `.env` and secrets; prints what to add to .gitignore when not. */
function ignoresSecrets(ctx: Context, out: string, envFile: string, secrets: SecretsLocation) {
  const missing = missingIgnores(out, envFile, secrets);
  if (missing.length > 0) {
    ctx.err(
      `Refusing to run: these would not be ignored by git, so real secrets could be committed.\nAdd to .gitignore and run again:\n${missing.map((m) => `  ${m}`).join("\n")}\n`,
    );
  }

  return missing.length === 0;
}

/** Resolves what to set up; undefined (after printing why) when the person is unknown or secrets are not ignored. */
async function planSetup(
  ctx: Context,
  options: SetupOptions & GlobalOptions,
  loaded: LoadedTeam,
  target: string,
): Promise<SetupPlan | undefined> {
  const { config } = loaded;
  const scope = scopeOf(target);
  const person = scope === "person" ? findPerson(ctx, config, target) : undefined;
  if (scope === "person" && !person) {
    return undefined;
  }

  const out = resolve(ctx.cwd, options.out ?? projectRoot(ctx, loaded.source));
  const secrets = secretsLocation(ctx, options, out, target);
  const envFile = envFileOf(scope, target);
  if (!ignoresSecrets(ctx, out, envFile, secrets)) {
    return undefined;
  }

  const { found, unknown } = configuredAdapters(config, await registryOf(ctx), scope, person);
  const teamDir = loaded.source.dir;
  return {
    config,
    teamDir,
    scope,
    target,
    person,
    out,
    secretsDir: secrets.dir,
    envFile,
    found,
    unknown,
  };
}

/** `ost setup --derive`: fills derivable secrets and reports what it wrote. */
async function deriveSecrets(
  ctx: Context,
  options: SetupOptions & GlobalOptions,
  plan: SetupPlan,
): Promise<number> {
  const dir = plan.secretsDir;
  const { config, found, scope, person } = plan;
  const report = await runDerive(ctx, config, found, scope, person, dir, options.yes === true);
  if (options.json) {
    ctx.out(
      `${JSON.stringify({ secretsDir: dir, written: report.written, warnings: report.warnings }, null, 2)}\n`,
    );

    return 0;
  }

  ctx.out(
    report.written.length > 0
      ? `Wrote ${report.written.join(", ")} to ${dir}\n`
      : "Nothing new to derive.\n",
  );

  for (const w of report.warnings) {
    ctx.out(`warning  ${w}\n`);
  }

  return 0;
}

export const setup = defineCommand<SetupOptions>({
  name: "setup",
  summary: "Prepare the credentials of one person or of the office.",
  description:
    "Without --derive, writes `.outstaff/people/<handle>/.env.example` (or `.outstaff/office/.env.example`), which lists every secret the configured adapters need for that scope with where to get it, and prints a step-by-step guide per adapter. It never writes a real value. With --derive, reads the secrets already provided (files in the secrets directory first, then the environment), looks up the values that can be computed, such as GitHub App slug and installation id, the chat bot's user id and the tracker member id, and writes them as files into the secrets directory without printing them. If a `<app slug>.*.pem` was just downloaded to ~/Downloads, offers to move it there as the App's private key. Refuses to run unless the `.env` file and the secrets directory are ignored by git.",
  args: "<handle|office>",
  options: [
    {
      flags: "--out <dir>",
      description:
        "Project directory to write `.outstaff/...` into. Defaults to the project root of the team file.",
    },
    {
      flags: "--derive",
      description:
        "Fill derivable secrets from the ones already provided instead of writing the template.",
    },
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of this scope's secret files, for the layout hint and for --derive. Defaults to OUTSTAFF_SECRETS_DIR, then .outstaff/secrets/<handle|office> next to the team file.",
    },
    {
      flags: "--yes",
      description: "Do not ask before moving a downloaded private key.",
    },
  ],
  examples: [
    "ost setup sam",
    "ost setup office --out .",
    "ost setup sam --derive --secrets-dir ./secrets-sam",
    "ost setup sam --derive --yes --json",
  ],
  exitCodes: [
    "0: the template was written, or values were derived",
    "1: the team could not be loaded, the person is unknown, or the git ignore rules are missing",
  ],
  async run(ctx, options, args) {
    const target = args[0] ?? "";
    const loaded = await loadTeam(ctx, options);
    if (!loaded.ok) {
      for (const i of loaded.issues) {
        ctx.err(`error    ${formatIssue(i)}\n`);
      }

      return 1;
    }

    const plan = await planSetup(ctx, options, loaded, target);
    if (!plan) {
      return 1;
    }

    return options.derive
      ? deriveSecrets(ctx, options, plan)
      : writeTemplate(ctx, options.json === true, plan);
  },
});
