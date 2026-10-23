import type { Store, WorkItem } from "./store/types.js";
import type { PrRecord, WorkState } from "./workstate/index.js";

/**
 * Instructions the office puts in the first journal entry of an item whose kind needs a known procedure, so the
 * agent starts with the steps instead of working them out. Undefined when the kind has no recipe.
 */
export async function recipeFor(
  item: Pick<WorkItem, "kind" | "subject">,
  store: Pick<Store, "getSubject">,
  workState: Pick<WorkState, "stackedOn">,
): Promise<string | undefined> {
  if (item.kind !== "conflict" || item.subject?.type !== "pr") {
    return undefined;
  }

  const pr = (await store.getSubject("pr", item.subject.ref))?.data as PrRecord | undefined;
  if (!pr) {
    return undefined;
  }

  const above = workState.stackedOn(pr.ref.repo, pr.headRef);
  return [
    `Pull request #${pr.ref.number} (${pr.title}) conflicts with \`${pr.baseRef}\`. Rebase \`${pr.headRef}\`:`,
    "",
    "    git fetch origin",
    `    git rebase origin/${pr.baseRef}`,
    "    git push --force-with-lease",
    "",
    `If \`${pr.baseRef}\` is a branch of a pull request that was merged and deleted, the stack moved on: retarget the pull request onto the default branch first and rebase with \`git rebase --onto origin/<default branch> <old base head> ${pr.headRef}\`.`,
    ...(above.length > 0
      ? [
          "",
          "Pull requests stacked on this one need the same rebase afterwards, bottom first:",
          ...above.map(
            (p, i) => `${i + 1}. #${p.ref.number} ${p.title}${p.url ? ` (${p.url})` : ""}`,
          ),
        ]
      : []),
  ].join("\n");
}
