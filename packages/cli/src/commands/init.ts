import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineCommand } from "../define.js";
import type { Context } from "../types.js";

/** Exact version of the catalog release this CLI ships with. */
export const catalogVersion = (): string => {
  const { version } = createRequire(import.meta.url)("@outstaff/catalog/package.json") as {
    version: string;
  };

  return version;
};

export const GITIGNORE_RULES = [".outstaff/secrets/", ".outstaff/**/.env", ".env", "*.pem"];

export function slugify(input: string, fallback: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  if (s === "") {
    return fallback;
  }

  return /^[a-z]/.test(s) ? s : `team-${s}`.slice(0, 40).replace(/-+$/g, "");
}

/** Turns an origin URL into `host/owner/repo`, or undefined when it has no recognisable shape. */
export function normalizeRemote(remote: string): string | undefined {
  const t = remote
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(t);
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(t);
  const m = scp ?? url;
  if (!m) {
    return undefined;
  }

  const path = m[2] as string;
  return /^[\w.-]+\/[\w.-]+$/.test(path) ? `${m[1]}/${path}` : undefined;
}

type TemplateInput = { team: string; repoUrl: string; repoName: string; separateRepo: boolean };

export function renderTemplate(i: TemplateInput): string {
  const repoNote = i.separateRepo
    ? `# This file lives in its own repository. The product repository goes here as
# \`kind: primary\`; the repository holding this file is not listed unless agents
# should work in it too.`
    : `# The repository that holds this file. \`kind: primary\` marks the product repo
# (at most one). Other kinds: baseline, infra, other.`;

  return `# Outstaff team configuration. Run \`ost validate\` after editing.
version: 1

team:
  name: ${i.team}
  # product: Name of what the team builds
  # description: One line about the team

# Trusted humans. Remove this block to use the default rule: repo writers and
# full chat-workspace members.
humans:
  - name: Your Name
    identities:
      vcs: your-vcs-username

catalog:
  version: ${catalogVersion()}

repos:
${repoNote.replace(/^/gm, "  ")}
  - name: ${i.repoName}
    url: ${i.repoUrl}
    kind: primary

# No people yet. Add agents with \`ost hire\`, or list them here with a handle,
# name, role and repo grants (for example \`${i.repoName}: write\`).
people: []

integrations:
  chat:
    adapter: slack
  vcs:
    adapter: github
  # Credentials (API key, cloud provider, or your own subscription token) are supplied by the operator to the containers, never written in this file.
  runtime:
    adapter: claude-agent-sdk
`;
}

function detectRepo(ctx: Context, separateRepo: boolean): { url: string; name: string } {
  const placeholder = { url: "github.com/your-org/your-repo", name: "product" };
  if (separateRepo) {
    return placeholder;
  }

  const origin = ctx.gitOrigin(ctx.cwd);
  const url = origin ? normalizeRemote(origin) : undefined;
  if (!url) {
    return placeholder;
  }

  return { url, name: slugify(url.split("/").at(-1) ?? "", "product") };
}

function updateGitignore(dir: string): string[] {
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_RULES.filter((r) => !have.has(r));
  if (missing.length === 0) {
    return [];
  }

  const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const header = have.has("# Outstaff secrets") ? "" : "# Outstaff secrets\n";
  writeFileSync(file, `${existing}${lead}${header}${missing.join("\n")}\n`);
  return missing;
}

export const init = defineCommand<{ separateRepo?: boolean; force?: boolean }>({
  name: "init",
  summary: "Scaffold .outstaff/team.yaml and .gitignore rules in the current directory.",
  description:
    "Writes a commented team.yaml with the team name taken from the directory name, one placeholder human, and the repo from `git remote get-url origin` when there is one. No people are added; the file points to `ost hire`. Appends rules that keep secrets out of git to .gitignore when missing. Refuses to overwrite an existing team file unless --force is given. The global --team option is ignored.",
  options: [
    {
      flags: "--separate-repo",
      description:
        "Write team.yaml at the repository root, for a repository that holds only the team config. The product repo then goes in `repos` as `kind: primary`.",
    },
    { flags: "--force", description: "Overwrite an existing team file." },
  ],
  examples: ["ost init", "ost init --separate-repo", "ost init --force"],
  exitCodes: [
    "0: files written",
    "1: the team file already exists (use --force) or could not be written",
  ],
  async run(ctx, options) {
    const relFile = options.separateRepo ? "team.yaml" : join(".outstaff", "team.yaml");
    const file = join(ctx.cwd, relFile);
    if (existsSync(file) && !options.force) {
      ctx.err(`${relFile} already exists. Use --force to overwrite it.\n`);
      return 1;
    }

    const repo = detectRepo(ctx, options.separateRepo === true);
    const text = renderTemplate({
      team: slugify(basename(ctx.cwd), "my-team"),
      repoUrl: repo.url,
      repoName: repo.name,
      separateRepo: options.separateRepo === true,
    });

    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    } catch (err) {
      ctx.err(`Cannot write ${relFile}: ${(err as Error).message}\n`);
      return 1;
    }

    const added = updateGitignore(ctx.cwd);
    ctx.out(`Wrote ${relFile}\n`);
    if (added.length > 0) {
      ctx.out(`Added to .gitignore: ${added.join(", ")}\n`);
    }

    ctx.out(`Next: edit ${relFile}, then run \`ost validate\`.\n`);
    return 0;
  },
});
