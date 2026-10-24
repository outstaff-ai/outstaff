import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AdapterRegistry,
  envSecretSource,
  formatIssue,
  type SecretSource,
  type SetupStep,
  type TeamConfig,
} from "@outstaff/core";
import { defineCommand, type Context } from "../define.js";
import { loadTeam } from "../load.js";
import { renderEnvExample, sections, type AnyDef, type Scope } from "./setup-template.js";

export const DEFAULT_SECRETS_DIR = "secrets";

/** Every adapter this build ships, for guides and derived values; loaded on demand to keep other commands fast. */
export async function shippedRegistry(): Promise<AdapterRegistry> {
  const [{ githubVcs }, { slackChat }, { itsaplanTracker, itsaplanKnowledge }, { claudeAgentSdk }] =
    await Promise.all([
      import("@outstaff/vcs-github"),
      import("@outstaff/chat-slack"),
      import("@outstaff/tracker-itsaplan"),
      import("@outstaff/runtime-agent-sdk"),
    ]);

  return new AdapterRegistry()
    .register(githubVcs)
    .register(slackChat)
    .register(itsaplanTracker)
    .register(itsaplanKnowledge)
    .register(claudeAgentSdk);
}

interface Configured {
  def: AnyDef;
  options: unknown;
}

export function configuredAdapters(
  team: TeamConfig,
  registry: AdapterRegistry,
  scope: Scope,
): { found: Configured[]; unknown: string[] } {
  const found: Configured[] = [];
  const unknown: string[] = [];
  for (const [port, ref] of Object.entries(team.integrations)) {
    if (!ref || (scope === "office" && port === "runtime")) {
      continue;
    }

    const def = registry.get(port as AnyDef["port"], ref.adapter);
    if (!def) {
      unknown.push(`${port}/${ref.adapter}`);
      continue;
    }

    const { adapter: _adapter, ...options } = ref;
    found.push({ def, options });
  }

  return { found, unknown };
}

/** git's own answer, so every ignore rule and nesting is honoured. Not a repository: nothing can be committed, so nothing to check. */
function isIgnored(dir: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: dir, stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== 1;
  }
}

function inRepo(dir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The ignore rules that are missing, as lines for `.gitignore`. */
export function missingIgnores(out: string, envFile: string, secretsDir: string): string[] {
  if (!inRepo(out)) {
    return [];
  }

  const missing: string[] = [];
  const envRule = envFile.startsWith(join(".outstaff", "office"))
    ? ".outstaff/office/.env"
    : ".outstaff/people/*/.env";

  if (!isIgnored(out, envFile.replaceAll("\\", "/"))) {
    missing.push(envRule);
  }

  const rel = relative(out, resolve(out, secretsDir));
  if (!rel.startsWith("..") && !isAbsolute(rel) && rel !== "") {
    if (!isIgnored(out, `${rel.replaceAll("\\", "/")}/KEY`)) {
      missing.push(`${rel.replaceAll("\\", "/")}/`);
    }
  }

  return missing;
}

export function renderGuide(title: string, steps: SetupStep[]): string {
  const lines = [`## ${title}`, ""];
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}`, "");
    lines.push(...step.body.split("\n").map((l) => (l ? `   ${l}` : l)), "");
    if (step.manifest) {
      lines.push(
        "   Paste or follow:",
        "",
        "   ```",
        ...step.manifest
          .trimEnd()
          .split("\n")
          .map((l) => `   ${l}`),
        "   ```",
        "",
      );
    }
  });

  return lines.join("\n");
}

/** Prefixes of the GitHub App key sets, whose downloaded `<slug>.<date>.private-key.pem` can be picked up. */
const APP_PREFIXES: Record<Scope, string[]> = {
  person: ["GH_APP_", "GH_OFFICE_APP_"],
  office: ["GH_OFFICE_APP_"],
};

function findDownloadedKey(downloads: string, slug: string): string | undefined {
  if (!existsSync(downloads)) {
    return undefined;
  }

  const wanted = `${slug.toLowerCase()}.`;
  return readdirSync(downloads)
    .filter((f) => f.toLowerCase().startsWith(wanted) && f.toLowerCase().endsWith(".pem"))
    .map((f) => join(downloads, f))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function writeSecret(dir: string, key: string, value: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, key);
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

interface DeriveReport {
  written: string[];
  warnings: string[];
}

async function runDerive(
  ctx: Context,
  team: TeamConfig,
  found: Configured[],
  scope: Scope,
  person: TeamConfig["people"][number] | undefined,
  dir: string,
  yes: boolean,
): Promise<DeriveReport> {
  const report: DeriveReport = { written: [], warnings: [] };
  const secrets: SecretSource = envSecretSource(ctx.env, dir);

  // A just-downloaded key is moved first so the lookups below can use it.
  const downloads = join(ctx.home ?? homedir(), "Downloads");
  for (const prefix of APP_PREFIXES[scope]) {
    const slug = secrets.get(`${prefix}SLUG`);
    if (!slug || secrets.get(`${prefix}PRIVATE_KEY`) || secrets.get(`${prefix}PRIVATE_KEY_FILE`)) {
      continue;
    }

    const pem = findDownloadedKey(downloads, slug);
    if (!pem) {
      continue;
    }

    const ask = `Move ${pem} to ${join(dir, `${prefix}PRIVATE_KEY`)}?`;
    const ok = yes || (ctx.confirm ? await ctx.confirm(ask) : false);
    if (!ok) {
      report.warnings.push(
        `Found ${pem} for the App ${slug}; run again with --yes to move it into the secrets directory.`,
      );

      continue;
    }

    writeSecret(dir, `${prefix}PRIVATE_KEY`, readFileSync(pem, "utf8").trim());
    unlinkSync(pem);
    report.written.push(`${prefix}PRIVATE_KEY`);
  }

  const fetchImpl = ctx.fetch ?? fetch;
  const seen = new Set<unknown>();
  for (const { def, options } of found) {
    if (!def.derive) {
      continue;
    }

    const allowed = new Set(
      def
        .secrets(scope, person ? { team, person } : undefined)
        .filter((s) => s.derivable)
        .map((s) => s.key),
    );

    let values: Record<string, string>;
    try {
      values = await def.derive(secrets, {
        team,
        scope,
        options,
        ...(person ? { person } : {}),
        fetch: fetchImpl,
        now: ctx.now ?? (() => new Date()),
        warn: (m) => report.warnings.push(`${def.name}: ${m}`),
      });
    } catch (e) {
      report.warnings.push(`${def.name}: ${(e as Error).message}`);
      continue;
    }

    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key)) {
        report.warnings.push(
          `${def.name}: ignored ${key}, which it does not declare as derivable.`,
        );
      } else if (!seen.has(key)) {
        seen.add(key);
        writeSecret(dir, key, value);
        report.written.push(key);
      }
    }
  }

  return report;
}

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
        "Project directory to write `.outstaff/...` into. Defaults to the current directory.",
    },
    {
      flags: "--derive",
      description:
        "Fill derivable secrets from the ones already provided instead of writing the template.",
    },
    {
      flags: "--secrets-dir <dir>",
      description:
        "Directory of secret files, for the layout hint and for --derive. Defaults to OUTSTAFF_SECRETS_DIR, then ./secrets.",
    },
    {
      flags: "--yes",
      description: "Do not ask before moving a downloaded private key.",
    },
  ],
  examples: [
    "ost setup sam",
    "ost setup office --out .",
    "ost setup sam --derive --secrets-dir ./secrets",
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

    const out = resolve(ctx.cwd, options.out ?? ".");
    const secretsDir = options.secretsDir ?? ctx.env["OUTSTAFF_SECRETS_DIR"] ?? DEFAULT_SECRETS_DIR;
    const envFile =
      scope === "office"
        ? join(".outstaff", "office", ".env")
        : join(".outstaff", "people", target, ".env");

    const missing = missingIgnores(out, envFile, resolve(ctx.cwd, secretsDir));
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
      const dir = resolve(ctx.cwd, secretsDir);
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
    const text = renderEnvExample(config, scope, target, list, secretsDir);
    const file = join(out, `${envFile}.example`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);

    const seen = new Set<string>();
    const guides: { adapter: string; steps: SetupStep[] }[] = [];
    for (const { def, options: opts } of found) {
      const steps =
        def.setupGuide?.({ team: config, scope, options: opts, ...(person ? { person } : {}) }) ??
        [];

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
            secretsDir,
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
    ctx.out(`Secret files go in ${secretsDir}/, one file per key.\n\n`);
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
