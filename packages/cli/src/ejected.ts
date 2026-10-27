import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TeamConfig } from "@outstaff/core";
import type { Context, EjectedIndex, EjectedRecord } from "./types.js";

/** Folders of a catalog that clients can eject. */
export const EJECTABLE = ["roles", "process", "references", "templates", "toolsets"] as const;

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

type FileMatch = (file: string) => boolean;

const roleFiles =
  (name: string): FileMatch =>
  (f) =>
    f.startsWith(`roles/${name}/`);

const markdownFile =
  (folder: string) =>
  (name: string): FileMatch => {
    const base = name.replace(/\.md$/, "");
    return (f) => f === `${folder}/${base}.md`;
  };

const toolsetFile = (name: string): FileMatch => {
  const base = name.replace(/\.ya?ml$/, "");
  return (f) => f === `toolsets/${base}.yaml` || f === `toolsets/${base}.yml`;
};

/** How `<folder>/<name>` picks stock files, per ejectable folder. */
const TARGET_MATCHES = new Map<string, (name: string) => FileMatch>([
  ["roles", roleFiles],
  ["process", markdownFile("process")],
  ["references", markdownFile("references")],
  ["templates", markdownFile("templates")],
  ["toolsets", toolsetFile],
]);

/** The stock files an eject target names; a bare name is a role. */
function targetMatch(target: string): FileMatch | undefined {
  const [head = "", ...rest] = target.split("/");
  const name = rest.join("/");
  return name ? TARGET_MATCHES.get(head)?.(name) : roleFiles(target);
}

/**
 * Resolves an eject target to stock file paths: a role name (or `roles/<name>`),
 * `process/<x>`, `references/<x>`, `templates/<x>` or `toolsets/<x>`.
 * Returns undefined when nothing matches.
 */
export function resolveTarget(stockDir: string, target: string): string[] | undefined {
  const all = allStockFiles(stockDir);
  const match = targetMatch(target.replace(/\/+$/, ""));
  const files = match ? all.filter(match) : [];
  return files.length ? files : undefined;
}

const isRelativePosix = (path: string) =>
  path !== "" && !path.startsWith("/") && !path.includes("\\") && !/^[A-Za-z]:/.test(path);

const hasDotOrEmptySegment = (parts: string[]) =>
  parts.some((s) => s === ".." || s === "." || s === "");

const isEjectableFile = (parts: string[]) =>
  parts.length >= 2 && (EJECTABLE as readonly string[]).includes(parts[0] ?? "");

function escapes(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, path));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** Why `path` cannot be an ejected file, or undefined when it can. */
export function badCatalogPath(dir: string, path: string): string | undefined {
  if (!isRelativePosix(path)) {
    return "must be a relative POSIX path";
  }

  const parts = path.split("/");
  if (hasDotOrEmptySegment(parts)) {
    return "must not contain empty, . or .. segments";
  }

  if (!isEjectableFile(parts)) {
    return `must start with one of ${EJECTABLE.join(", ")} and name a file`;
  }

  return escapes(dir, path) ? "resolves outside the ejected catalog" : undefined;
}

/** The record file's content, which must be a JSON object. */
function readIndexObject(file: string): object {
  let index: unknown;
  try {
    index = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }

  if (typeof index !== "object" || index === null || Array.isArray(index)) {
    throw new Error(`${file} must be a JSON object.`);
  }

  return index;
}

function checkEntry(dir: string, file: string, path: string, record: unknown): void {
  const bad = badCatalogPath(dir, path);
  if (bad) {
    throw new Error(`${file}: invalid entry "${path}": ${bad}.`);
  }

  const r = record as Partial<EjectedRecord> | null;
  if (typeof r?.version !== "string" || typeof r.sha256 !== "string") {
    throw new Error(`${file}: entry "${path}" needs a version and a sha256.`);
  }
}

export function readIndex(dir: string): EjectedIndex {
  const file = join(dir, RECORD_FILE);
  if (!existsSync(file)) {
    return {};
  }

  const index = readIndexObject(file);
  for (const [path, record] of Object.entries(index)) {
    checkEntry(dir, file, path, record);
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
