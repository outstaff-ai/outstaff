import type { Check, RepoRef } from "@outstaff/core";
import type { ContextMerge, ContextMergeOther } from "@outstaff/protocol";
import { ciOf } from "#/workstate/derive.js";
import type { PrRecord } from "#/workstate/index.js";
import type { ContextReaders } from "./types.js";

/** The latest merges into the base the context names. */
export const RECENT_MERGES = 5;

/** The other open pull requests whose files are read, newest first: a call each. */
const FILES_READ = 10;

/** The files of an overlap, and failing checks, a context names. */
const LISTED = 5;

type Relation = ContextMergeOther["relation"][number];

/** Best effort: a context goes out with what could be read. */
async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

const keyIn = (prKey: string, number: number) =>
  `${prKey.slice(0, prKey.lastIndexOf("#"))}#${number}`;

const verdictsOf = (rec: PrRecord, state: "approved" | "changes_requested") =>
  (rec.verdicts ?? []).filter((v) => v.state === state).map((v) => v.actor);

const failing = (checks: { name: string; status: string; url?: string | undefined }[]) =>
  checks
    .filter((c) => c.status === "failure")
    .slice(0, LISTED)
    .map((c) => ({ name: c.name, ...(c.url ? { url: c.url } : {}) }));

/** How another open pull request relates to this one. */
function relationOf(self: PrRecord, other: PrRecord, overlap: string[]): Relation[] {
  const found: [boolean, Relation][] = [
    [other.baseRef === self.headRef, "stacked_on_it"],
    [self.baseRef === other.headRef, "under_it"],
    [other.baseRef === self.baseRef, "same_base"],
    [overlap.length > 0, "overlapping_files"],
  ];

  return found.filter(([holds]) => holds).map(([, r]) => r);
}

/** Closest first: the stack, then overlapping files, then the same base, then the rest; newest first within. */
function rank(o: ContextMergeOther): number {
  if (o.relation.includes("stacked_on_it") || o.relation.includes("under_it")) {
    return 0;
  }

  if (o.relation.includes("overlapping_files")) {
    return 1;
  }

  return o.relation.includes("same_base") ? 2 : 3;
}

/** The files each pull request changes, for this one and the newest others; none when the code host cannot say. */
async function filesOf(r: ContextReaders, repo: RepoRef, prs: PrRecord[]) {
  const list = r.vcs?.changedFiles?.bind(r.vcs);
  const files = new Map<number, Set<string>>();
  if (!list) {
    return files;
  }

  for (const p of prs) {
    const found = await attempt(() => list(repo, p.ref.number));
    if (found) {
      files.set(p.ref.number, new Set(found));
    }
  }

  return files;
}

function otherOf(self: PrRecord, key: string, o: PrRecord, overlap: string[]): ContextMergeOther {
  const approved = verdictsOf(o, "approved").length > 0;
  return {
    ref: keyIn(key, o.ref.number),
    number: o.ref.number,
    title: o.title,
    ...(o.url ? { url: o.url } : {}),
    author: o.author.person ?? o.author.login,
    draft: o.draft,
    approved: approved && verdictsOf(o, "changes_requested").length === 0,
    ci: o.ci,
    mergeable: o.mergeable,
    relation: relationOf(self, o, overlap),
    files: overlap.slice(0, LISTED),
  };
}

/** The base branch's checks, read now; unknown when the code host cannot say. */
async function baseOf(r: ContextReaders, rec: PrRecord): Promise<ContextMerge["base"]> {
  const vcs = r.vcs;
  const checks: Check[] | undefined =
    vcs && (await attempt(() => vcs.checks(rec.ref.repo, rec.baseRef)));

  return checks
    ? { ref: rec.baseRef, ci: ciOf(checks), failing: failing(checks) }
    : { ref: rec.baseRef, ci: "unknown", failing: [] };
}

const newest = (a: PrRecord, b: PrRecord) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/**
 * What a merge is decided with: the pull request's own state; the repository's other open pull requests and how each
 * relates to it (stacked on it or under it, the same base, files both change), related ones first and at most `limit`;
 * the latest merges into its base; and the base's checks. Each with its link. Undefined when the office does not know
 * the pull request.
 */
export async function mergeContextOf(
  r: ContextReaders,
  key: string,
  limit: number,
): Promise<ContextMerge | undefined> {
  const rec = (await r.store.getSubject("pr", key))?.data as PrRecord | undefined;
  if (!rec || !r.prs) {
    return undefined;
  }

  const all = r.prs(rec.ref.repo);
  const open = all
    .filter((p) => p.state === "open" && p.ref.number !== rec.ref.number)
    .toSorted(newest);

  const files = await filesOf(r, rec.ref.repo, [rec, ...open.slice(0, FILES_READ)]);
  const mine = files.get(rec.ref.number) ?? new Set<string>();
  const others = open
    .map((o) =>
      otherOf(
        rec,
        key,
        o,
        [...(files.get(o.ref.number) ?? [])].filter((f) => mine.has(f)).toSorted(),
      ),
    )
    .toSorted((a, b) => rank(a) - rank(b));

  const merged = all
    .filter((p) => p.state === "merged" && p.baseRef === rec.baseRef)
    .toSorted(newest)
    .slice(0, RECENT_MERGES);

  return {
    pr: {
      ref: key,
      number: rec.ref.number,
      title: rec.title,
      ...(rec.url ? { url: rec.url } : {}),
      head: rec.headRef,
      base: rec.baseRef,
      draft: rec.draft,
      approvedBy: verdictsOf(rec, "approved"),
      changesRequestedBy: verdictsOf(rec, "changes_requested"),
      ci: rec.ci,
      failing: failing(rec.checks),
      mergeable: rec.mergeable,
      unresolvedThreads: rec.unresolvedThreads,
    },
    base: await baseOf(r, rec),
    others: others.slice(0, limit),
    ...(others.length > limit ? { moreOthers: others.length - limit } : {}),
    recentMerges: merged.map((p) => ({
      ref: keyIn(key, p.ref.number),
      number: p.ref.number,
      title: p.title,
      ...(p.url ? { url: p.url } : {}),
      author: p.author.person ?? p.author.login,
      at: p.updatedAt,
    })),
  };
}
