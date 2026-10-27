import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_CODES } from "./codes.js";
import { cacheKey, defaultCacheDir, nodeFs, nodeGit, parseGitUrl } from "./io.js";
import { parseYaml } from "./locate.js";
import { parseTeamConfig } from "./parse.js";
import type {
  ConfigFs,
  ConfigIssue,
  ConfigSource,
  GitClient,
  LoadOptions,
  LoadResult,
  LocatedIssue,
} from "./types.js";

const CANDIDATES = [join(".outstaff", "team.yaml"), "team.yaml"];

export function formatIssue(issue: LocatedIssue): string {
  return `${issue.file}:${issue.line}:${issue.column} ${issue.code}: ${issue.message}`;
}

const fail = (
  file: string,
  code: string,
  message: string,
  position = { line: 1, column: 1 },
): LoadResult => ({
  ok: false,
  issues: [{ path: [], code, message, file, ...position }],
});

type Resolved = { source: ConfigSource; base: string } | { error: LoadResult };

/** Where to load the team config from, and what to load it with. */
type SourceRequest = {
  target: string | undefined;
  envRef: string | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  fs: ConfigFs;
  git: GitClient;
  cacheDir: string | undefined;
};

/**
 * Precedence: explicit `team` option, then OUTSTAFF_TEAM_FILE, then
 * OUTSTAFF_TEAM_REPO (+ OUTSTAFF_TEAM_REF), then discovery in `cwd`.
 */
export async function loadTeamConfig(options: LoadOptions = {}): Promise<LoadResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const resolved = await resolveSource({
    ...teamTarget(options.team, env),
    cwd,
    env,
    fs,
    git: options.git ?? nodeGit,
    cacheDir: options.cacheDir,
  });

  if ("error" in resolved) {
    return resolved.error;
  }

  const { source, base } = resolved;
  const file = display(source, base, cwd);
  let text: string;
  try {
    text = await fs.readFile(source.file);
  } catch (err) {
    return {
      ...fail(file, CONFIG_CODES.readFailed, `Cannot read file: ${(err as Error).message}`),
      source,
    };
  }

  return parseSource(text, file, source);
}

/** The `team` option or OUTSTAFF_TEAM_FILE; without either, OUTSTAFF_TEAM_REPO and its OUTSTAFF_TEAM_REF. */
function teamTarget(
  team: string | undefined,
  env: NodeJS.ProcessEnv,
): Pick<SourceRequest, "target" | "envRef"> {
  if (team !== undefined || env.OUTSTAFF_TEAM_FILE) {
    return { target: team ?? env.OUTSTAFF_TEAM_FILE, envRef: undefined };
  }

  const repo = env.OUTSTAFF_TEAM_REPO;

  return {
    target: repo ?? env.OUTSTAFF_TEAM_FILE,
    envRef: repo ? env.OUTSTAFF_TEAM_REF || undefined : undefined,
  };
}

function parseSource(text: string, file: string, source: ConfigSource): LoadResult {
  const parsed = parseYaml(text);
  if (parsed.syntaxErrors.length > 0) {
    return {
      ok: false,
      source,
      issues: parsed.syntaxErrors.map((e) => ({
        path: [],
        code: CONFIG_CODES.yamlSyntax,
        message: e.message,
        file,
        ...e.position,
      })),
    };
  }

  const result = parseTeamConfig(parsed.value);
  if (result.ok) {
    return { ok: true, config: result.config, source };
  }

  return {
    ok: false,
    source,
    issues: result.issues.map((i: ConfigIssue) => ({ ...i, file, ...parsed.locate(i) })),
  };
}

/** Path shown in messages: relative to the checkout for git sources, to `cwd` when inside it. */
function display(source: ConfigSource, base: string, cwd: string): string {
  const rel = relative(source.kind === "git" ? base : cwd, source.file);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? source.file : rel;
}

async function resolveSource(a: SourceRequest): Promise<Resolved> {
  if (a.target === undefined) {
    return discoverUp(a.cwd, a.fs);
  }

  const gitUrl = parseGitUrl(a.target);

  return gitUrl ? gitSource(gitUrl, a) : pathSource(a.target, a);
}

/** A config repository, fetched into the cache. */
async function gitSource(
  gitUrl: { url: string; ref?: string | undefined },
  a: SourceRequest,
): Promise<Resolved> {
  const ref = gitUrl.ref ?? a.envRef;
  const refPart = ref ? { ref } : {};
  const dir = join(a.cacheDir ?? defaultCacheDir(a.env), cacheKey(gitUrl.url, ref));
  try {
    await a.git.sync({ url: gitUrl.url, ...refPart, dir });
  } catch (err) {
    const msg = `Cannot fetch ${gitUrl.url}${ref ? `#${ref}` : ""}: ${errorText(err)}`;
    return { error: fail(gitUrl.url, CONFIG_CODES.gitFailed, msg) };
  }

  return discover(dir, "git", a.fs, a.cwd, { repo: gitUrl.url, ...refPart });
}

const errorText = (err: unknown): string =>
  ((err as { stderr?: string }).stderr || (err as Error).message).trim();

/** A named file, or a directory to look for the config in. */
async function pathSource(target: string, a: SourceRequest): Promise<Resolved> {
  const path = resolve(a.cwd, target);
  const kind = await a.fs.kind(path);
  if (kind === "file") {
    return { source: { kind: "file", file: path, dir: dirname(path) }, base: a.cwd };
  }

  if (kind === "dir") {
    return discover(path, "file", a.fs, a.cwd);
  }

  return { error: fail(target, CONFIG_CODES.notFound, `No team config at ${path}.`) };
}

/** Directories to look in when nothing was named: `cwd` and its parents up to the repository root (the first with a `.git`). Outside a repository only `cwd`. */
async function searchDirs(cwd: string, fs: ConfigFs): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(dir);
    if ((await fs.kind(join(dir, ".git"))) !== null) {
      return dirs;
    }

    if (dirname(dir) === dir) {
      return [cwd];
    }
  }
}

async function discoverUp(cwd: string, fs: ConfigFs): Promise<Resolved> {
  const dirs = await searchDirs(cwd, fs);
  for (const dir of dirs) {
    for (const c of CANDIDATES) {
      const file = join(dir, c);
      if ((await fs.kind(file)) === "file") {
        return { source: { kind: "file", file, dir: dirname(file) }, base: dir };
      }
    }
  }

  const shown = CANDIDATES.map((c) => relative(cwd, join(cwd, c)) || c);
  const last = dirs.at(-1) ?? cwd;
  return {
    error: fail(
      shown[0] ?? "team.yaml",
      CONFIG_CODES.notFound,
      `No team config found. Looked in: ${shown.join(", ")}${last === cwd ? "" : `, and in the parent directories up to ${last}`}.`,
    ),
  };
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
    if ((await fs.kind(file)) === "file") {
      return { source: { kind, file, dir: dirname(file), ...extra }, base: dir };
    }
  }

  const shown = tried.map((t) => relative(cwd, t) || t);
  return {
    error: fail(
      shown[0] ?? "team.yaml",
      CONFIG_CODES.notFound,
      `No team config found. Looked in: ${shown.join(", ")}.`,
    ),
  };
}
