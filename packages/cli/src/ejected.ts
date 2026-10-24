import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { formatIssue, type ConfigSource, type TeamConfig } from "@outstaff/core";
import { stockCatalogDir } from "./catalogs.js";
import type { Context, GlobalOptions } from "./define.js";
import { loadTeam } from "./load.js";

/** Folders of a catalog that clients can eject. */
export const EJECTABLE = ["roles", "process", "references", "templates", "toolsets"] as const;

export type EjectedRecord = { version: string; sha256: string };
export type EjectedIndex = Record<string, EjectedRecord>;

export const RECORD_FILE = ".ejected.json";
export const BASE_DIR = ".base";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `catalog.path` next to the team file. */
export const ejectedDir = (teamDir: string, config: TeamConfig): string =>
  resolve(teamDir, config.catalog.path);

/** Version of the installed stock catalog. */
export function stockVersion(stockDir: string): string {
  const v = (
    JSON.parse(readFileSync(join(stockDir, "package.json"), "utf8")) as { version?: string }
  ).version;

  if (!v) {
    throw new Error(`No "version" in ${join(stockDir, "package.json")}.`);
  }

  return v;
}

const walk = (root: string, rel: string): string[] => {
  const dir = join(root, rel);
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .toSorted()
    .flatMap((n) => {
      const next = `${rel}/${n}`;
      return statSync(join(root, next)).isDirectory() ? walk(root, next) : [next];
    });
};

/** Every ejectable file of the stock catalog, as forward-slash paths. */
export const allStockFiles = (stockDir: string): string[] =>
  EJECTABLE.flatMap((d) => walk(stockDir, d));

/**
 * Resolves an eject target to stock file paths: a role name (or `roles/<name>`),
 * `process/<x>`, `references/<x>`, `templates/<x>` or `toolsets/<x>`.
 * Returns undefined when nothing matches.
 */
export function resolveTarget(stockDir: string, target: string): string[] | undefined {
  const clean = target.replace(/\/+$/, "");
  const [head, ...rest] = clean.split("/");
  const name = rest.join("/");
  const all = allStockFiles(stockDir);
  const pick = (pred: (f: string) => boolean) => {
    const files = all.filter(pred);
    return files.length ? files : undefined;
  };

  if (head === "roles" && name) {
    return pick((f) => f.startsWith(`roles/${name}/`));
  }

  if (head && ["process", "references", "templates"].includes(head) && name) {
    const base = name.replace(/\.md$/, "");
    return pick((f) => f === `${head}/${base}.md`);
  }

  if (head === "toolsets" && name) {
    const base = name.replace(/\.ya?ml$/, "");
    return pick((f) => f === `toolsets/${base}.yaml` || f === `toolsets/${base}.yml`);
  }

  if (!name) {
    return pick((f) => f.startsWith(`roles/${clean}/`));
  }

  return undefined;
}

/** Why `path` cannot be an ejected file, or undefined when it can. */
export function badCatalogPath(dir: string, path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    return "must be a relative POSIX path";
  }

  const parts = path.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) {
    return "must not contain empty, . or .. segments";
  }

  if (parts.length < 2 || !(EJECTABLE as readonly string[]).includes(parts[0] ?? "")) {
    return `must start with one of ${EJECTABLE.join(", ")} and name a file`;
  }

  const rel = relative(resolve(dir), resolve(dir, path));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return "resolves outside the ejected catalog";
  }

  return undefined;
}

export function readIndex(dir: string): EjectedIndex {
  const file = join(dir, RECORD_FILE);
  if (!existsSync(file)) {
    return {};
  }

  let index: unknown;
  try {
    index = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }

  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    throw new Error(`${file} must be a JSON object.`);
  }

  for (const [path, record] of Object.entries(index)) {
    const bad = badCatalogPath(dir, path);
    if (bad) {
      throw new Error(`${file}: invalid entry "${path}": ${bad}.`);
    }

    const r = record as Partial<EjectedRecord> | null;
    if (typeof r?.version !== "string" || typeof r.sha256 !== "string") {
      throw new Error(`${file}: entry "${path}" needs a version and a sha256.`);
    }
  }

  return index as EjectedIndex;
}

/** readIndex that prints the error instead of throwing. */
export function tryIndex(ctx: Context, dir: string): EjectedIndex | undefined {
  try {
    return readIndex(dir);
  } catch (e) {
    ctx.err(`error    ${(e as Error).message}\n`);
    return undefined;
  }
}

export function writeIndex(dir: string, index: EjectedIndex): void {
  const sorted = Object.fromEntries(
    Object.entries(index).toSorted(([a], [b]) => a.localeCompare(b)),
  );

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RECORD_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
}

export function writeFileDeep(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export const baseFile = (dir: string, path: string): string => join(dir, BASE_DIR, path);

/** Conflict markers left in a file by `ost upgrade`. */
export const hasConflictMarkers = (text: string): boolean =>
  /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);

export type MergeResult = { text: string; conflicts: number };

/** Three-way merge with `git merge-file`; conflicts use standard markers. */
export function mergeThreeWay(ours: string, base: string, theirs: string): MergeResult {
  const tmp = mkdtempSync(join(tmpdir(), "ost-merge-"));
  try {
    const files = {
      ours: join(tmp, "client"),
      base: join(tmp, "base"),
      theirs: join(tmp, "stock"),
    };

    writeFileSync(files.ours, ours);
    writeFileSync(files.base, base);
    writeFileSync(files.theirs, theirs);
    const r = spawnSync(
      "git",
      [
        "merge-file",
        "-p",
        "-L",
        "client",
        "-L",
        "base",
        "-L",
        "stock",
        files.ours,
        files.base,
        files.theirs,
      ],
      { encoding: "utf8" },
    );

    if (r.error) {
      throw new Error(`Cannot run git: ${r.error.message}`);
    }

    if (r.status === null || r.status < 0 || r.status > 127) {
      throw new Error(`git merge-file failed: ${r.stderr.trim()}`);
    }

    return { text: r.stdout, conflicts: r.status };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Unified diff of two texts, headed `a/<path>` and `b/<path>`; empty when equal. */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }

  const tmp = mkdtempSync(join(tmpdir(), "ost-diff-"));
  try {
    writeFileDeep(join(tmp, "a", path), before);
    writeFileDeep(join(tmp, "b", path), after);
    const r = spawnSync(
      "git",
      [
        "-c",
        "core.quotepath=off",
        "diff",
        "--no-index",
        "--no-color",
        "--no-prefix",
        "--no-ext-diff",
        `a/${path}`,
        `b/${path}`,
      ],
      { cwd: tmp, encoding: "utf8" },
    );

    if (r.error) {
      throw new Error(`Cannot run git: ${r.error.message}`);
    }

    // Drop the "diff --git" and "index" lines; keep from "---" on.
    const lines = r.stdout.split("\n");
    const start = lines.findIndex((l) => l.startsWith("--- "));
    return start < 0 ? r.stdout : lines.slice(start).join("\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Sets `catalog.version` in team.yaml text, keeping quotes and comments. Returns undefined if not found. */
export function setCatalogVersion(yaml: string, version: string): string | undefined {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^catalog\s*:/.test(l));
  if (at < 0) {
    return undefined;
  }

  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "" && !/^\s/.test(line)) {
      break;
    }

    const m = /^(\s+version\s*:\s*)(["']?)[^\s"'#]+\2(.*)$/.exec(line);
    if (m) {
      const q = m[2] ?? "";
      lines[i] = `${m[1]}${q}${version}${q}${m[3]}`;
      return lines.join("\n");
    }
  }

  return undefined;
}

export type OpenedTeam = {
  config: TeamConfig;
  source: ConfigSource;

  /** Absolute path of the ejected catalog directory. */
  dir: string;
  stockDir: string;
};

/** Loads the team and locates the ejected catalog; prints the errors and returns an exit code on failure. */
export async function openTeam(
  ctx: Context,
  options: GlobalOptions,
): Promise<{ ok: true; team: OpenedTeam } | { ok: false; code: number }> {
  const loaded = await loadTeam(ctx, options);
  if (!loaded.ok) {
    for (const i of loaded.issues) {
      ctx.err(`error    ${formatIssue(i)}\n`);
    }

    return { ok: false, code: 1 };
  }

  if (loaded.source.kind !== "file") {
    ctx.err("error    This command edits files, so --team must be a local path, not a git URL.\n");
    return { ok: false, code: 1 };
  }

  return {
    ok: true,
    team: {
      config: loaded.config,
      source: loaded.source,
      dir: ejectedDir(loaded.source.dir, loaded.config),
      stockDir: stockCatalogDir(ctx),
    },
  };
}
