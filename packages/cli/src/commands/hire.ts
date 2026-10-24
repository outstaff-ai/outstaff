import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  AdapterRegistry,
  type SetupStep,
  envSecretSource,
  silentLogger,
  type Avatars,
  type TeamConfig,
} from "@outstaff/core";
import { catalogIssue, loadCatalogs } from "../catalogs.js";
import { defineCommand, type Context } from "../define.js";
import { openTeam } from "../ejected.js";
import { generateName, HANDLE, baseHandle, uniqueHandle, RESERVED_HANDLES } from "../hire-names.js";
import { projectRoot, secretsLocation } from "../project.js";
import { composeSnippet, k8sKustomization } from "../hire-snippets.js";
import { addPerson, type NewPerson } from "../teamfile.js";
import { missingIgnores, renderGuide, setup } from "./setup.js";
import { validate } from "./validate.js";

type SetupJson = {
  file: string;
  secretsDir: string;
  keys: string[];
  guides: { adapter: string; steps: SetupStep[] }[];
  unsupported: string[];
};

type Grants = NewPerson["repos"];

const KIND_KEY = /^kind:(primary|baseline|infra|other)$/;

/** Write access where the role does its work, read everywhere else. */
export function defaultGrants(config: TeamConfig, permissions: string): Grants {
  const kind = permissions === "code" ? "primary" : permissions === "infra" ? "infra" : undefined;
  const grants: Grants = {};
  for (const r of config.repos) {
    if (kind && r.kind === kind) {
      grants[r.name] = "write";
    }
  }

  grants["*"] = "read";
  return grants;
}

export function formatGrants(grants: Grants): string {
  return Object.entries(grants)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** `shop=write,*=read` to grants, or the reason it is not valid. */
export function parseGrants(text: string, config: TeamConfig): Grants | string {
  const grants: Grants = {};
  for (const part of text.split(",").map((s) => s.trim())) {
    if (part === "") {
      continue;
    }

    const [key, access, ...rest] = part.split("=").map((s) => s.trim());
    if (!key || rest.length > 0 || (access !== "read" && access !== "write")) {
      return `"${part}" is not repo=read or repo=write.`;
    }

    if (key !== "*" && !KIND_KEY.test(key) && !config.repos.some((r) => r.name === key)) {
      return `"${key}" is not a repo of this team (repos: ${config.repos.map((r) => r.name).join(", ")}), "kind:<kind>" or "*".`;
    }

    grants[key] = access;
  }

  return Object.keys(grants).length > 0 ? grants : "Give at least one grant, for example *=read.";
}

/** A fixed set of adapters that render avatars, for teams whose `integrations.avatars` names one. */
async function avatarRegistry(ctx: Context): Promise<AdapterRegistry> {
  if (ctx.registry?.list("avatars").length) {
    return ctx.registry;
  }

  const { dicebearAvatars, directoryAvatars, urlAvatars } =
    await import("@outstaff/avatars-dicebear");

  return new AdapterRegistry()
    .register(dicebearAvatars)
    .register(directoryAvatars)
    .register(urlAvatars);
}

async function renderAvatar(
  ctx: Context,
  config: TeamConfig,
  seed: string,
  secretsDir: string,
): Promise<{ data: Uint8Array; ext: "png" | "svg" } | { skipped: string }> {
  const ref = config.integrations.avatars;
  if (!ref) {
    return { skipped: "No integrations.avatars in the team file, so no avatar was rendered." };
  }

  const def = (await avatarRegistry(ctx)).get("avatars", ref.adapter);
  if (!def) {
    return { skipped: `Avatar adapter "${ref.adapter}" is not shipped in this build.` };
  }

  const { adapter: _adapter, ...raw } = ref;
  const options = def.options.parse(raw);
  const avatars: Avatars = await def.create({
    options,
    secrets: envSecretSource(ctx.env, secretsDir),
    team: config,
    log: silentLogger,
    fetch: ctx.fetch ?? fetch,
    now: ctx.now ?? (() => new Date()),
  });

  const image = await avatars.render(seed);
  return { data: image.data, ext: image.mime === "image/png" ? "png" : "svg" };
}

const given = (v: string | undefined): string | undefined => v?.trim() || undefined;

const capture = (ctx: Context): { ctx: Context; text: () => string } => {
  let out = "";
  let err = "";
  return {
    ctx: { ...ctx, out: (t) => void (out += t), err: (t) => void (err += t) },
    text: () => out + err,
  };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const hire = defineCommand<{
  name?: string;
  handle?: string;
  pronouns?: string;
  model?: string;
  avatar?: string;
  repos?: string;
  yes?: boolean;
  out?: string;
  secretsDir?: string;
}>({
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

    const interactive = !options.yes && !options.json && ctx.ask !== undefined;
    const ask = async (question: string, fallback: string): Promise<string> =>
      interactive ? ctx.ask!(question, fallback) : fallback;

    const taken = config.people.map((p) => p.handle);
    if ([options.name, options.handle, options.pronouns, options.model].some((v) => v === "")) {
      ctx.err("error    An option was given an empty value.\n");
      return 1;
    }

    const name = await ask("Name", given(options.name) ?? generateName(taken));
    if (/[\r\n]/.test(name)) {
      ctx.err("error    The name must be a single line.\n");
      return 1;
    }

    const wanted = given(options.handle);
    const handle = await ask("Handle", wanted ?? uniqueHandle(baseHandle(name), taken));
    if (!HANDLE.test(handle) || RESERVED_HANDLES.includes(handle)) {
      ctx.err(
        `error    "${handle}" is not a valid handle: use lowercase letters, digits and dashes, starting with a letter, at most 30, and not "office".\n`,
      );

      return 1;
    }

    if (taken.includes(handle)) {
      ctx.err(`error    The handle "${handle}" is already used by another person.\n`);
      return 1;
    }

    const pronouns = await ask("Pronouns", given(options.pronouns) ?? "they/them");
    const model = given(options.model);

    let grants: Grants | string = options.repos
      ? parseGrants(options.repos, config)
      : defaultGrants(config, roleDef.permissions);

    if (typeof grants === "string") {
      ctx.err(`error    --repos: ${grants}\n`);
      return 1;
    }

    if (interactive && !options.repos) {
      grants = parseGrants(
        await ask("Repo access (repo=read|write, comma separated)", formatGrants(grants)),
        config,
      );

      if (typeof grants === "string") {
        ctx.err(`error    ${grants}\n`);
        return 1;
      }
    }

    const avatarArg = given(options.avatar);
    const isUrl = avatarArg !== undefined && /^https?:\/\//i.test(avatarArg);
    if (isUrl && !URL.canParse(avatarArg)) {
      ctx.err(`error    --avatar: "${avatarArg}" is not a valid URL.\n`);
      return 1;
    }

    const seed = isUrl ? handle : (avatarArg ?? handle);
    const person: NewPerson = {
      handle,
      name,
      pronouns,
      role,
      ...(model ? { model } : {}),
      repos: grants,
      avatar: isUrl ? { url: avatarArg } : { seed },
    };

    const summary = [
      `Handle:    ${handle}`,
      `Name:      ${name}`,
      `Pronouns:  ${pronouns}`,
      `Role:      ${role}`,
      `Model:     ${model ?? "(the runtime's default)"}`,
      `Repos:     ${formatGrants(grants)}`,
      `Avatar:    ${isUrl ? avatarArg : `seed ${seed}`}`,
    ];

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

    // The same code as `ost setup <handle>`; its JSON is read back so the next steps can use the key list.
    const sub = capture(ctx);
    const setupCode = await setup.run(
      sub.ctx,
      {
        ...(options.team !== undefined ? { team: options.team } : {}),
        out,
        ...(options.secretsDir !== undefined ? { secretsDir: options.secretsDir } : {}),
        json: true,
      },
      [handle],
    );

    const setupJson = parseJson(sub.text()) as SetupJson | undefined;
    const keys = setupJson?.keys ?? [];
    if (!setupJson) {
      ctx.err(sub.text());
    } else if (!options.json) {
      ctx.out(`Wrote ${shown(setupJson.file)}\n`);
      ctx.out(`Secret files go in ${shown(setupJson.secretsDir)}/, one file per key.\n\n`);
      for (const g of setupJson.guides) {
        ctx.out(`${renderGuide(g.adapter, g.steps)}\n`);
      }

      for (const u of setupJson.unsupported) {
        ctx.out(`${u}: not shipped in this build, so no secrets or guide are listed for it.\n`);
      }

      ctx.out(`When the keys are in place, run \`ost setup ${handle} --derive\` for the rest.\n\n`);
    }

    const nextSteps = {
      identities: [
        "identities.vcs: the login of the person's GitHub App bot, for example <app-slug>[bot]",
        "identities.chat: the Slack bot user id",
        "identities.tracker: the person's member in the tracker",
      ],
      compose: composeSnippet(handle, keys),
      k8s: {
        folder: `people/${handle}/kustomization.yaml`,
        kustomization: k8sKustomization(handle),
        listIn: `Add "- people/${handle}" to resources in the top kustomization.yaml.`,
      },
      doctor: `ost doctor ${handle}`,
    };

    if (!options.json) {
      ctx.out(
        [
          "Next steps",
          "",
          `1. Create the person's accounts and apps with the guide above, then fill the identities of ${handle} in the team file:`,
          ...nextSteps.identities.map((l) => `     ${l}`),
          `2. Compose: add this to your compose file. The secret names are those of the acme example's adapters (github, slack, itsaplan, claude-agent-sdk); the list comes from \`ost setup ${handle}\`, so check it against the .env.example it wrote.`,
          "",
          ...nextSteps.compose.split("\n").map((l) => `     ${l}`),
          "",
          `   Kubernetes: add ${nextSteps.k8s.folder}, and list it in the top kustomization.yaml. Create the Secret outstaff-agent-${handle} from the same keys, and add OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")} to outstaff-office.`,
          "",
          ...nextSteps.k8s.kustomization
            .trimEnd()
            .split("\n")
            .map((l) => `     ${l}`),
          "",
          `3. Check it: ost doctor ${handle}`,
          `4. Start the container, and say hello to ${name} in the team's chat channel once ${handle} is connected.`,
          "",
        ].join("\n"),
      );

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
