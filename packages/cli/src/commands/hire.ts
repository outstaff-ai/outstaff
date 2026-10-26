import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { catalogIssue, loadCatalogs } from "../catalogs.js";
import { defineCommand } from "../define.js";
import { openTeam } from "../open-team.js";
import { projectRoot, secretsLocation } from "../project.js";
import { addPerson } from "../teamfile.js";
import { renderAvatar } from "./hire/avatar.js";
import { capture, parseJson } from "./hire/capture.js";
import { nextStepsOf, renderNextSteps } from "./hire/next-steps.js";
import { choosePerson } from "./hire/person.js";
import { runSetup } from "./hire/setup-step.js";
import type { HireOptions } from "./hire/types.js";
import { missingIgnores } from "./setup/ignores.js";
import { validate } from "./validate.js";

export const hire = defineCommand<HireOptions>({
  name: "hire",
  summary: "Add a person to the team and prepare them to start.",
  description:
    "Adds one person with the given role (stock or custom) to `people` in the team file, keeping its comments and quoting. Anything not given is generated: the name from a small built-in list of neutral names, the handle from the name (a DNS label, made unique with a numeric suffix), the pronouns they/them, the repo grants (write on the primary repository for code roles and on the infra repository for infra roles, read everywhere else), the avatar seed (the handle) and the model (left out, so the runtime adapter's default applies). In a terminal it asks about each generated value, shows a summary and asks to confirm; without a terminal it needs --yes. Then it renders the avatar to `.outstaff/people/<handle>/avatar.png|svg` when the team configures an avatars adapter and the avatar is not a URL, does what `ost setup <handle>` does, prints what is left to do by hand (the person's identities in the team file, the compose service or the Kubernetes folder to add) and runs `ost validate`. Nothing is created in GitHub, the chat workspace or the tracker.",
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
      description: "LLM model. Omitted from the file by default, so the runtime's default applies.",
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
    "ost hire developer",
    'ost hire reviewer --name "Ines Varga" --pronouns she/her --yes',
    'ost hire developer --repos "shop=write,*=read" --avatar sam --yes --json',
  ],
  exitCodes: [
    "0: the person was added and the team file validates",
    "1: the team could not be loaded, the role or an option is invalid, the person was not confirmed, the git ignore rules for setup are missing, or the team file has errors after the change",
  ],
  async run(ctx, options, args) {
    const [role, ...extra] = args;
    if (role === undefined || extra.length > 0) {
      ctx.err("error    Give exactly one role.\n");
      return 1;
    }

    const opened = await openTeam(ctx, options);
    if (!opened.ok) {
      return opened.code;
    }

    const { config, source } = opened.team;
    const found = loadCatalogs(ctx, config, source.dir);
    if (!found.ok) {
      for (const i of found.issues) {
        ctx.err(`error    ${catalogIssue(i).message}\n`);
      }

      return 1;
    }

    const roles = { ...found.catalogs.stock.roles, ...found.catalogs.ejected?.roles };
    const roleDef = roles[role];
    if (!roleDef) {
      ctx.err(
        `error    No role "${role}". Roles: ${Object.keys(roles).toSorted().join(", ")}. Create one with \`ost role new\`.\n`,
      );

      return 1;
    }

    const chosen = await choosePerson(ctx, options, config, role, roleDef.permissions);
    if (typeof chosen === "number") {
      return chosen;
    }

    const { person, summary, name, handle, seed, isUrl } = chosen;

    const out = resolve(ctx.cwd, options.out ?? projectRoot(ctx, source));
    const secrets = secretsLocation(ctx, options, out, handle);
    const result = (extraFields: Record<string, unknown>) =>
      `${JSON.stringify({ person, ...extraFields }, null, 2)}\n`;

    if (!options.yes) {
      if (!options.json) {
        ctx.out(`${summary.join("\n")}\n`);
      }

      const ok =
        !options.json && ctx.confirm ? await ctx.confirm(`Add ${name} to the team?`) : false;

      if (!ok) {
        if (options.json) {
          ctx.out(result({ written: false }));
        }

        ctx.err(
          ctx.confirm && !options.json
            ? "Nothing was written.\n"
            : "error    Not confirmed, so nothing was written. Run again with --yes to write.\n",
        );

        return 1;
      }
    }

    const missing = missingIgnores(out, join(".outstaff", "people", handle, ".env"), secrets);

    if (missing.length > 0) {
      ctx.err(
        `error    Nothing was written: these would not be ignored by git, so real secrets could be committed.\nAdd to .gitignore and run again:\n${missing.map((m) => `  ${m}`).join("\n")}\n`,
      );

      return 1;
    }

    try {
      writeFileSync(source.file, addPerson(readFileSync(source.file, "utf8"), person));
    } catch (e) {
      ctx.err(`error    Cannot edit ${source.file}: ${(e as Error).message}\n`);
      return 1;
    }

    const notes: string[] = [];
    let avatarFile: string | null = null;
    if (isUrl) {
      notes.push("The avatar is a URL; it is stored in the team file and nothing was rendered.");
    } else {
      try {
        const image = await renderAvatar(ctx, config, seed, secrets.dir);
        if ("skipped" in image) {
          notes.push(image.skipped);
        } else {
          avatarFile = join(out, ".outstaff", "people", handle, `avatar.${image.ext}`);
          mkdirSync(join(avatarFile, ".."), { recursive: true });
          writeFileSync(avatarFile, image.data);
        }
      } catch (e) {
        notes.push(`The avatar could not be rendered: ${(e as Error).message}`);
      }
    }

    const shown = (file: string) => relative(ctx.cwd, file) || file;
    if (!options.json) {
      ctx.out(`Added ${name} (${handle}) to ${shown(source.file)}\n`);
      if (avatarFile) {
        ctx.out(`Wrote ${shown(avatarFile)}\n`);
      }

      ctx.out("\n");
    }

    const { setupCode, setupJson, keys } = await runSetup(ctx, options, out, handle, shown);
    const nextSteps = nextStepsOf(handle, keys);
    if (!options.json) {
      ctx.out(renderNextSteps(nextSteps, name, handle));

      for (const n of notes) {
        ctx.out(`note     ${n}\n`);
      }
    }

    const checks = options.json ? capture(ctx) : { ctx, text: () => "" };
    if (!options.json) {
      ctx.out("\n");
    }

    const validateCode = await validate.run(
      checks.ctx,
      {
        ...(options.team !== undefined ? { team: options.team } : {}),
        json: options.json === true,
      },
      [],
    );

    if (options.json) {
      ctx.out(
        result({
          written: true,
          file: source.file,
          avatar: avatarFile,
          notes,
          setup: { ok: setupCode === 0, ...setupJson },
          nextSteps,
          validate: parseJson(checks.text()) ?? null,
        }),
      );
    }

    return setupCode === 0 && validateCode === 0 ? 0 : 1;
  },
});
