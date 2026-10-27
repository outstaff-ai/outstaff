import { prLabel } from "../log.js";
import type { PrSnapshot, MergeChange } from "./derive.types.js";
import type { MergeDerivedType, PipelineEvent } from "./events.types.js";

/** The id of an event a merge raised for a pull request. */
export const derivedId = (type: string, pr: PrSnapshot, merged: PrSnapshot): string =>
  `derived:${type}:${prLabel(pr.ref)}:after:${prLabel(merged.ref)}`;

export const sameRepo = (a: PrSnapshot, b: PrSnapshot): boolean =>
  a.ref.repo.owner === b.ref.repo.owner && a.ref.repo.name === b.ref.repo.name;

/**
 * What a merge changed under each other open pull request of its repository, whoever authored or merged them:
 * - `pr.base_merged` when the pull request was stacked on the merged branch;
 * - `pr.conflicted` when its base received the merge and it now conflicts, even if it conflicted before, because the
 *   base it conflicts with is new; or when it turned conflicting while its base did not change;
 * - `pr.behind_base` when its base received the merge, it does not conflict, and the repository requires branches to
 *   be up to date.
 *
 * The work state keeps no base commit, so "its base received the merge" means the pull request targets the branch the
 * merged one targeted. Each event names the merge as `data.cause`.
 */
export function deriveAfterMerge(change: MergeChange): PipelineEvent[] {
  const { merged, at } = change;
  const before = new Map(change.before.map((p) => [prLabel(p.ref), p]));
  const cause = { pr: merged.ref, title: merged.title, url: merged.url };
  const events: PipelineEvent[] = [];
  const raise = (type: MergeDerivedType, pr: PrSnapshot) =>
    events.push({
      id: derivedId(type, pr, merged),
      type,
      at,
      subject: { pr: pr.ref, ...(pr.ticket ? { ticket: pr.ticket } : {}) },
      actor: { kind: "automation", id: "office" },
      data: { cause, base: pr.baseRef },
    });

  for (const pr of change.after) {
    if (pr.state !== "open" || !sameRepo(pr, merged) || prLabel(pr.ref) === prLabel(merged.ref)) {
      continue;
    }

    const conflicting = pr.mergeable === "conflicting";
    if (pr.baseRef === merged.headRef) {
      raise("pr.base_merged", pr);
    } else if (pr.baseRef === merged.baseRef) {
      if (conflicting) {
        raise("pr.conflicted", pr);
      } else if (change.requiresUpToDate) {
        raise("pr.behind_base", pr);
      }
    } else if (conflicting && before.get(prLabel(pr.ref))?.mergeable !== "conflicting") {
      raise("pr.conflicted", pr);
    }
  }

  return events;
}
