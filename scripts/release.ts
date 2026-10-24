// Works out the next release from conventional commits and writes it into the repository:
// the version of every published package, CHANGELOG.md and a notes file. It does not commit,
// tag, publish or push; the Release workflow does that around it, in that order.
//
//   node scripts/release.ts [--level auto|patch|minor|major] [--dry-run] [--notes-file <path>]
//
// stdout carries only `key=value` lines for the workflow (version, tag, prerelease, skip).
// Everything human-readable goes to stderr.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  isPrerelease,
  nextVersion,
  parseCommit,
  prependChangelog,
  releaseNotes,
  setPackageVersion,
  type Commit,
  type Level,
} from "./release-lib.ts";

const root = path.resolve(import.meta.dirname, "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function lastTag(): string | null {
  const tags = git("tag", "--list", "v*", "--merged", "HEAD", "--sort=-v:refname");
  return tags.split("\n").find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ?? null;
}

function commitsSince(tag: string | null): Commit[] {
  const range = tag === null ? "HEAD" : `${tag}..HEAD`;
  const raw = git("log", "--no-merges", "--format=%H%x1f%B%x1e", range);
  const commits: Commit[] = [];
  for (const record of raw.split("\x1e")) {
    const [hash, message] = record.trim().split("\x1f");
    const commit = hash && message ? parseCommit(hash, message) : null;
    if (commit) {
      commits.push(commit);
    }
  }

  return commits;
}

function publishedManifests(): string[] {
  const packages = path.join(root, "packages");
  return readdirSync(packages)
    .map((dir) => path.join(packages, dir, "package.json"))
    .filter((file) => {
      try {
        return JSON.parse(readFileSync(file, "utf8")).private !== true;
      } catch {
        return false;
      }
    });
}

function out(key: string, value: string): void {
  process.stdout.write(`${key}=${value}\n`);
}

const { values } = parseArgs({
  options: {
    level: { type: "string", default: "auto" },
    "dry-run": { type: "boolean", default: false },
    "notes-file": { type: "string" },
  },
});

const level = values.level as Level;
if (!["auto", "patch", "minor", "major"].includes(level)) {
  throw new Error(`unknown level: ${level}`);
}

const manifests = publishedManifests();
const catalog = path.join(root, "packages/catalog/package.json");
const tag = lastTag();
// With no tag yet the base is the version the packages carry now (0.0.0 before the first release).
const base = tag === null ? JSON.parse(readFileSync(catalog, "utf8")).version : tag.slice(1);
const commits = commitsSince(tag);
const version = nextVersion(base, commits, level);

console.error(`last tag: ${tag ?? "none"}, base ${base}, ${commits.length} conventional commits`);
if (version === null) {
  console.error("nothing to release: no feat, fix, perf or breaking commits since the last tag");
  out("skip", "true");
  out("version", "");
  process.exit(0);
}

const notes = releaseNotes(commits);
console.error(`next version: ${version}\n\n${notes}\n`);

if (!values["dry-run"]) {
  for (const file of manifests) {
    writeFileSync(file, setPackageVersion(readFileSync(file, "utf8"), version));
  }

  const changelog = path.join(root, "CHANGELOG.md");
  let existing: string | null = null;
  try {
    existing = readFileSync(changelog, "utf8");
  } catch {
    // first release: no changelog yet
  }

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelog, prependChangelog(existing, version, date, notes));
  console.error(`wrote ${manifests.length} package.json files and CHANGELOG.md`);
}

if (values["notes-file"]) {
  writeFileSync(values["notes-file"], `${notes}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release v${version}\n\n${notes}\n`);
}

out("skip", "false");
out("version", version);
out("tag", `v${version}`);
out("prerelease", String(isPrerelease(version)));
