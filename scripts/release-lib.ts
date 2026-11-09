// Pure functions behind scripts/release.ts: conventional commits in, version, notes and changelog out.

import type { Bump, Commit, Level } from "./release.types.ts";

const HEADER = /^([a-z]+)(?:\(([^)\n]+)\))?(!)?: (.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: ?(.*(?:\n(?!\s*\n).*)*)/m;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// The text of a BREAKING CHANGE footer on one line, or null when there is none or it is empty.
function breakingNote(footer: RegExpExecArray | null): string | null {
  const note = footer?.[1]?.trim().replaceAll(/\s*\n\s*/g, " ");
  return note || null;
}

export function parseCommit(hash: string, message: string): Commit | null {
  const [header = "", ...rest] = message.trim().split("\n");
  const match = HEADER.exec(header.trim());
  if (!match) {
    return null;
  }

  const footer = BREAKING_FOOTER.exec(rest.join("\n"));
  return {
    hash,
    type: match[1] as string,
    scope: match[2] ?? null,
    breaking: match[3] === "!" || footer !== null,
    summary: (match[4] as string).trim(),
    breakingNote: breakingNote(footer),
  };
}

export function parseVersion(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`not a plain x.y.z version: ${version}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// The bump the commits ask for, or null when nothing in them is releasable.
// Below 1.0.0 a breaking change bumps the minor, because 0.x makes no stability promise.
export function bumpFor(commits: readonly Commit[], base: string): Bump | null {
  const [major] = parseVersion(base);
  let bump: Bump | null = null;
  for (const commit of commits) {
    if (commit.breaking) {
      return major === 0 ? "minor" : "major";
    }

    if (commit.type === "feat") {
      bump = "minor";
    } else if ((commit.type === "fix" || commit.type === "perf") && bump === null) {
      bump = "patch";
    }
  }

  return bump;
}

export function increment(base: string, bump: Bump): string {
  const [major, minor, patch] = parseVersion(base);
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }

  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

// Returns the next version, or null for "nothing to release". An explicit level always
// releases (even with no commits); auto follows the commits.
export function nextVersion(base: string, commits: readonly Commit[], level: Level): string | null {
  if (level !== "auto") {
    return increment(base, level);
  }

  const bump = bumpFor(commits, base);
  return bump === null ? null : increment(base, bump);
}

// A release candidate, and every 0.x release, is a prerelease.
export function isPrerelease(version: string): boolean {
  const [plain = "", suffix] = version.split("-", 2);
  return suffix !== undefined || parseVersion(plain)[0] === 0;
}

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

// The next release candidate of `target`: one more than the highest v<target>-rc.N among
// `tags`, or rc.1. Release candidates of other versions do not count.
export function nextRc(target: string, tags: readonly string[]): string {
  const prefix = `v${target}-rc.`;
  let highest = 0;
  for (const tag of tags) {
    const n = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    if (/^\d+$/.test(n)) {
      highest = Math.max(highest, Number(n));
    }
  }

  return `${target}-rc.${highest + 1}`;
}

// Sort key of a v* tag: x.y.z, then the rc number, with the plain release above all its rcs.
function tagKey(tag: string): number[] | null {
  const match = RELEASE_TAG.exec(tag);
  if (!match) {
    return null;
  }

  const rc = match[4] === undefined ? Number.POSITIVE_INFINITY : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), rc];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const i = a.findIndex((n, index) => n !== b[index]);
  return i === -1 ? 0 : (a[i] as number) - (b[i] as number);
}

// The highest release tag in `tags`, or null. Plain releases only (vX.Y.Z) by default; with
// `rc` release candidates count too, which is where the notes of a release candidate start.
export function latestTag(tags: readonly string[], rc = false): string | null {
  const ranked = tags
    .flatMap((tag) => {
      const key = tagKey(tag);
      return key !== null && (rc || key[3] === Number.POSITIVE_INFINITY) ? [{ tag, key }] : [];
    })
    .toSorted((a, b) => compareKeys(b.key, a.key));

  return ranked[0]?.tag ?? null;
}

const SECTIONS: readonly { title: string; types: readonly string[] }[] = [
  { title: "Features", types: ["feat"] },
  { title: "Fixes", types: ["fix"] },
  { title: "Performance", types: ["perf"] },
  { title: "Other", types: ["docs", "refactor", "revert", "build", "ci"] },
];

function line(commit: Commit): string {
  const scope = commit.scope === null ? "" : `**${commit.scope}:** `;
  return `- ${scope}${commit.summary} (${commit.hash.slice(0, 7)})`;
}

// chore, test and style commits are not worth a reader's time, so they stay out of the notes.
// A breaking commit of any type is listed under Breaking changes only.
export function releaseNotes(commits: readonly Commit[]): string {
  const blocks: string[] = [];
  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length > 0) {
    const lines = breaking.map((c) =>
      c.breakingNote === null ? line(c) : `${line(c)}\n  ${c.breakingNote}`,
    );

    blocks.push(`### Breaking changes\n\n${lines.join("\n")}`);
  }

  for (const section of SECTIONS) {
    const lines = commits
      .filter((c) => !c.breaking && section.types.includes(c.type))
      .map((c) => line(c));

    if (lines.length > 0) {
      blocks.push(`### ${section.title}\n\n${lines.join("\n")}`);
    }
  }

  return blocks.length === 0 ? "No notable changes." : blocks.join("\n\n");
}

const CHANGELOG_TITLE = "# Changelog";

export function prependChangelog(
  existing: string | null,
  version: string,
  date: string,
  notes: string,
): string {
  const heading = `## v${version} (${date})`;
  const body = existing ?? "";
  if (new RegExp(`^## v${version.replaceAll(".", "\\.")} `, "m").test(body)) {
    throw new Error(`CHANGELOG.md already has an entry for v${version}`);
  }

  const entry = `${heading}\n\n${notes.trim()}\n`;
  if (!body.startsWith(CHANGELOG_TITLE)) {
    return `${CHANGELOG_TITLE}\n\n${entry}${body.trim() === "" ? "" : `\n${body.trimStart()}`}`;
  }

  const rest = body.slice(CHANGELOG_TITLE.length).trimStart();
  return `${CHANGELOG_TITLE}\n\n${entry}${rest === "" ? "" : `\n${rest}`}`;
}

// Replaces the first top-level "version" in package.json text, leaving the formatting alone.
export function setPackageVersion(text: string, version: string): string {
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!pattern.test(text)) {
    throw new Error("package.json has no version field");
  }

  return text.replace(pattern, `$1"${version}"`);
}
