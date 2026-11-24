// Works out the next release from conventional commits and writes it into the repository:
// the version of every published package, CHANGELOG.md and a notes file. It does not commit,
// tag, publish or push; the Release workflow does that around it, in that order.
// With --rc it works out the next release candidate (<next>-rc.N) instead and writes only the
// notes file: a release candidate is a tag, not a release commit.
//
//   node scripts/release.ts [--level auto|patch|minor|major] [--rc] [--dry-run] [--notes-file <path>]
//
// stdout carries only `key=value` lines for the workflow (version, tag, prerelease, skip).
// Everything human-readable goes to stderr.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  isPrerelease,
  latestTag,
  nextRc,
  nextVersion,
  parseCommit,
  prependChangelog,
  releaseNotes,
  setPackageVersion,
} from "./release-lib.ts";
import type { Commit, Level } from "./release.types.ts";

const root = path.resolve(import.meta.dirname, "..");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function tags(...args: string[]): string[] {
  return git("tag", "--list", "v*", ...args)
    .split("\n")
    .filter((tag) => tag !== "");
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

const subdirs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));

// Packages live in packages/<name> and integrations/<port>/<vendor>.
function publishedManifests(): string[] {
  const dirs = [
    ...subdirs(path.join(root, "packages")),
    ...subdirs(path.join(root, "integrations")).flatMap(subdirs),
  ];

  return dirs
    .map((dir) => path.join(dir, "package.json"))
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
    rc: { type: "boolean", default: false },
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
const rc = values.rc;
const merged = tags("--merged", "HEAD");
const tag = latestTag(merged);
// With no tag yet the base is the version the packages carry now (0.0.0 before the first release).
const base = tag === null ? JSON.parse(readFileSync(catalog, "utf8")).version : tag.slice(1);
const commits = commitsSince(tag);
const next = nextVersion(base, commits, level);

console.error(`last tag: ${tag ?? "none"}, base ${base}, ${commits.length} conventional commits`);
if (next === null) {
  console.error("nothing to release: no feat, fix, perf or breaking commits since the last tag");
  out("skip", "true");
  out("version", "");
  process.exit(0);
}

// A release candidate is numbered after every existing tag, merged or not, so its tag is new.
// Its notes start at the previous tag of any kind, so each candidate lists only what is new.
const version = rc ? nextRc(next, tags()) : next;
const notesTag = rc ? latestTag(merged, true) : tag;
const notes = releaseNotes(notesTag === tag ? commits : commitsSince(notesTag));
console.error(
  `next version: ${version}, notes since ${notesTag ?? "the first commit"}\n\n${notes}\n`,
);

if (!values["dry-run"] && !rc) {
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
