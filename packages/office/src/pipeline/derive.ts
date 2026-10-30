import { prLabel } from "#/log.js";
import type { PrSnapshot, MergeChange } from "./derive.types.js";
import type { MergeDerivedType, PipelineEvent } from "@outstaff/policy";

/** The id of an event a merge raised for a pull request. */
export const derivedId = (type: string, pr: PrSnapshot, merged: PrSnapshot): string =>
  `derived:${type}:${prLabel(pr.ref)}:after:${prLabel(merged.ref)}`;

export const sameRepo = (a: PrSnapshot, b: PrSnapshot): boolean =>
  a.ref.repo.owner === b.ref.repo.owner && a.ref.repo.name === b.ref.repo.name;

/** The code host requires the pull request's branch to be up to date with its base before it merges. */
const mustBeUpToDate = ({ requirements }: MergeChange, pr: PrSnapshot): boolean =>
  requirements.upToDate && pr.baseRef === requirements.branch;

/** The open pull requests of the merged one's repository, other than it: the ones a merge can change something under. */
const affected = (change: MergeChange): PrSnapshot[] =>
  change.after.filter(
    (pr) =>
      pr.state === "open" &&
      sameRepo(pr, change.merged) &&
      prLabel(pr.ref) !== prLabel(change.merged.ref),
  );

const conflicting = (pr: PrSnapshot | undefined) => pr?.mergeable === "conflicting";

/** Stacked on the merged branch: its base is gone. */
const stackedOnMerged = (pr: PrSnapshot, change: MergeChange): MergeDerivedType | undefined =>
  pr.baseRef === change.merged.headRef ? "pr.base_merged" : undefined;

/** Targets the branch the merge went into: its base moved, so it conflicts with the new base or is behind it. */
function sameBase(pr: PrSnapshot, change: MergeChange): MergeDerivedType | undefined {
  if (pr.baseRef !== change.merged.baseRef) {
    return undefined;
  }

  if (conflicting(pr)) {
    return "pr.conflicted";
  }

  return mustBeUpToDate(change, pr) ? "pr.behind_base" : undefined;
}

/** Targets another branch: only a change into conflicting is news. */
const otherBase = (pr: PrSnapshot, change: MergeChange): MergeDerivedType | undefined => {
  const was = change.before.find((p) => prLabel(p.ref) === prLabel(pr.ref));
  return conflicting(pr) && !conflicting(was) ? "pr.conflicted" : undefined;
};

/** Tried in order: the first relation that applies decides. */
const RELATIONS = [stackedOnMerged, sameBase, otherBase];

/**
 * What a merge changed under each other open pull request of its repository, whoever authored or merged them:
 * - `pr.base_merged` when the pull request was stacked on the merged branch;
 * - `pr.conflicted` when its base received the merge and it now conflicts, even if it conflicted before, because the
 *   base it conflicts with is new; or when it turned conflicting while its base did not change;
 * - `pr.behind_base` when its base received the merge, it does not conflict, and the code host requires branches into
 *   that base to be up to date (`requirements`, read through the vcs port).
 *
 * The work state keeps no base commit, so "its base received the merge" means the pull request targets the branch the
 * merged one targeted. Each event names the merge as `data.cause`.
 */
export function deriveAfterMerge(change: MergeChange): PipelineEvent[] {
  const { merged, at } = change;
  const cause = { pr: merged.ref, title: merged.title, url: merged.url };
  return affected(change).flatMap((pr): PipelineEvent[] => {
    const type = RELATIONS.map((relation) => relation(pr, change)).find((t) => t !== undefined);
    return type
      ? [
          {
            id: derivedId(type, pr, merged),
            type,
            at,
            subject: { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) },
            actor: { kind: "automation", id: "office" },
            data: { cause, base: pr.baseRef },
          },
        ]
      : [];
  });
}
