import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_CODES } from "./codes.js";
import { cacheKey, defaultCacheDir, nodeFs, nodeGit, parseGitUrl, type ConfigFs, type GitClient } from "./io.js";
import type { ConfigIssue } from "./issues.js";
import { parseYaml, type LocatedIssue } from "./locate.js";
import { parseTeamConfig } from "./parse.js";
import type { TeamConfig } from "./schema.js";

export type { LocatedIssue } from "./locate.js";

export type ConfigSource = {
  kind: "file" | "git";
  /** Absolute path of the team file. */
  file: string;
  /** Directory containing the team file; `catalog.path` is relative to it. */
  dir: string;
  repo?: string;
  ref?: string;
};

export type LoadOptions = {
  /** Path to a file or directory, or a git URL with an optional `#ref`. */
  team?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  fs?: ConfigFs;
  git?: GitClient;
};

export type LoadResult =
  | { ok: true; config: TeamConfig; source: ConfigSource }
  | { ok: false; issues: LocatedIssue[]; source?: ConfigSource };

const CANDIDATES = [join(".outstaff", "team.yaml"), "team.yaml"];

export function formatIssue(issue: LocatedIssue): string {
  return `${issue.file}:${issue.line}:${issue.column} ${issue.code}: ${issue.message}`;
}

const fail = (file: string, code: string, message: string, position = { line: 1, column: 1 }): LoadResult => ({
  ok: false,
  issues: [{ path: [], code, message, file, ...position }],
});

type Resolved = { source: ConfigSource; base: string } | { error: LoadResult };

/**
 * Precedence: explicit `team` option, then OUTSTAFF_TEAM_FILE, then
 * OUTSTAFF_TEAM_REPO (+ OUTSTAFF_TEAM_REF), then discovery in `cwd`.
 */
export async function loadTeamConfig(options: LoadOptions = {}): Promise<LoadResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const git = options.git ?? nodeGit;

  const target = options.team ?? env.OUTSTAFF_TEAM_FILE;
  const envRepo = options.team === undefined && !env.OUTSTAFF_TEAM_FILE ? env.OUTSTAFF_TEAM_REPO : undefined;
  const ref = envRepo ? env.OUTSTAFF_TEAM_REF || undefined : undefined;

  const resolved = await resolveSource({ target: envRepo ?? target, envRef: ref, cwd, env, fs, git, cacheDir: options.cacheDir });
  if ("error" in resolved) return resolved.error;
  const { source, base } = resolved;

  let text: string;
  try {
    text = await fs.readFile(source.file);
  } catch (err) {
    return { ...fail(display(source, base, cwd), CONFIG_CODES.readFailed, `Cannot read file: ${(err as Error).message}`), source };
  }

  const file = display(source, base, cwd);
  const parsed = parseYaml(text);
  if (parsed.syntaxErrors.length > 0) {
    return {
      ok: false,
      source,
      issues: parsed.syntaxErrors.map((e) => ({ path: [], code: CONFIG_CODES.yamlSyntax, message: e.message, file, ...e.position })),
    };
  }
  const result = parseTeamConfig(parsed.value);
  if (result.ok) return { ok: true, config: result.config, source };
  return { ok: false, source, issues: result.issues.map((i: ConfigIssue) => ({ ...i, file, ...parsed.locate(i) })) };
}

/** Path shown in messages: relative to the checkout for git sources, to `cwd` when inside it. */
function display(source: ConfigSource, base: string, cwd: string): string {
  const rel = relative(source.kind === "git" ? base : cwd, source.file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? source.file : rel;
}

async function resolveSource(a: {
  target: string | undefined;
  envRef: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: ConfigFs;
  git: GitClient;
  cacheDir: string | undefined;
}): Promise<Resolved> {
  const { target, cwd, fs } = a;
  if (target === undefined) return discover(cwd, "file", fs, cwd);

  const gitUrl = parseGitUrl(target);
  if (gitUrl) {
    const ref = gitUrl.ref ?? a.envRef;
    const dir = join(a.cacheDir ?? defaultCacheDir(a.env), cacheKey(gitUrl.url, ref));
    try {
      await a.git.sync({ url: gitUrl.url, ...(ref ? { ref } : {}), dir });
    } catch (err) {
      const msg = `Cannot fetch ${gitUrl.url}${ref ? `#${ref}` : ""}: ${((err as { stderr?: string }).stderr || (err as Error).message).trim()}`;
      return { error: fail(gitUrl.url, CONFIG_CODES.gitFailed, msg) };
    }
    return discover(dir, "git", fs, cwd, { repo: gitUrl.url, ...(ref ? { ref } : {}) });
  }

  const path = resolve(cwd, target);
  const kind = await fs.kind(path);
  if (kind === "file") return { source: { kind: "file", file: path, dir: dirname(path) }, base: cwd };
  if (kind === "dir") return discover(path, "file", fs, cwd);
  return { error: fail(target, CONFIG_CODES.notFound, `No team config at ${path}.`) };
}

async function discover(
  dir: string,
  kind: "file" | "git",
  fs: ConfigFs,
  cwd: string,
  extra: { repo?: string; ref?: string } = {},
): Promise<Resolved> {
  const tried = CANDIDATES.map((c) => join(dir, c));
  for (const file of tried) {
    if ((await fs.kind(file)) === "file") return { source: { kind, file, dir: dirname(file), ...extra }, base: dir };
  }
  const shown = tried.map((t) => relative(cwd, t) || t);
  return { error: fail(shown[0] ?? "team.yaml", CONFIG_CODES.notFound, `No team config found. Looked in: ${shown.join(", ")}.`) };
}
