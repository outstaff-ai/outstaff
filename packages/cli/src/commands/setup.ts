import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatIssue, type SetupStep } from "@outstaff/core";
import { loadCatalogs, roleProfile } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { loadTeam } from "../load.js";
import { projectRoot, secretsLocation, shown } from "../project.js";
import { renderEnvExample, sections } from "./setup-template.js";
import { runDerive } from "./setup/derive.js";
import { renderGuide } from "./setup/guide.js";
import { missingIgnores } from "./setup/ignores.js";
import { configuredAdapters, shippedRegistry } from "./setup/registry.js";
import type { Scope } from "./types.js";

export const setup = defineCommand<{
  out?: string;
  derive?: boolean;
  secretsDir?: string;
  yes?: boolean;
}>({
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

    const { config } = loaded;
    const scope: Scope = target === "office" ? "office" : "person";
    const person = scope === "person" ? config.people.find((p) => p.handle === target) : undefined;
    if (scope === "person" && !person) {
      ctx.err(
        `Unknown person "${target}". People in this team: ${config.people.map((p) => p.handle).join(", ") || "none"}. Use "office" for the office.\n`,
      );

      return 1;
    }

    const out = resolve(ctx.cwd, options.out ?? projectRoot(ctx, loaded.source));
    const secrets = secretsLocation(ctx, options, out, target);
    const envFile =
      scope === "office"
        ? join(".outstaff", "office", ".env")
        : join(".outstaff", "people", target, ".env");

    const missing = missingIgnores(out, envFile, secrets);
    if (missing.length > 0) {
      ctx.err(
        `Refusing to run: these would not be ignored by git, so real secrets could be committed.\nAdd to .gitignore and run again:\n${missing.map((m) => `  ${m}`).join("\n")}\n`,
      );

      return 1;
    }

    const registry =
      ctx.registry && ctx.registry.list().length > 0 ? ctx.registry : await shippedRegistry();

    const { found, unknown } = configuredAdapters(config, registry, scope);

    if (options.derive) {
      const dir = secrets.dir;
      const report = await runDerive(ctx, config, found, scope, person, dir, options.yes === true);
      if (options.json) {
        ctx.out(
          `${JSON.stringify({ secretsDir: dir, written: report.written, warnings: report.warnings }, null, 2)}\n`,
        );
      } else {
        ctx.out(
          report.written.length > 0
            ? `Wrote ${report.written.join(", ")} to ${dir}\n`
            : "Nothing new to derive.\n",
        );

        for (const w of report.warnings) {
          ctx.out(`warning  ${w}\n`);
        }
      }

      return 0;
    }

    const defs = found.map((f) => f.def);
    const list = sections(config, defs, scope, person);
    const text = renderEnvExample(config, scope, target, list, shown(ctx, secrets.dir));
    const file = join(out, `${envFile}.example`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);

    const catalogs = loadCatalogs(ctx, config, loaded.source.dir);
    const profile = person
      ? roleProfile(catalogs.ok ? catalogs.catalogs : undefined, person.role)
      : {};

    const seen = new Set<string>();
    const guides: { adapter: string; steps: SetupStep[] }[] = [];
    for (const { def, options: opts } of found) {
      const steps =
        def.setupGuide?.({
          team: config,
          scope,
          options: opts,
          ...(person ? { person } : {}),
          ...profile,
        }) ?? [];

      const key = JSON.stringify([def.name, steps]);
      if (steps.length > 0 && !seen.has(key)) {
        seen.add(key);
        guides.push({ adapter: `${def.name} (${def.port})`, steps });
      }
    }

    if (options.json) {
      ctx.out(
        `${JSON.stringify(
          {
            file,
            secretsDir: secrets.dir,
            keys: list.flatMap((s) => s.specs.map((k) => k.key)),
            guides,
            unsupported: unknown,
          },
          null,
          2,
        )}\n`,
      );

      return 0;
    }

    ctx.out(`Wrote ${relative(ctx.cwd, file) || file}\n`);
    ctx.out(`Secret files go in ${shown(ctx, secrets.dir)}/, one file per key.\n\n`);
    for (const g of guides) {
      ctx.out(`${renderGuide(g.adapter, g.steps)}\n`);
    }

    for (const u of unknown) {
      ctx.out(`${u}: not shipped in this build, so no secrets or guide are listed for it.\n`);
    }

    ctx.out(`When the keys are in place, run \`ost setup ${target} --derive\` for the rest.\n`);
    return 0;
  },
});
