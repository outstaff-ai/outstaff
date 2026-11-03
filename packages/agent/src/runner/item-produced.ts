import type { RepoRef, Vcs } from "@outstaff/core";
import type { OfficeClient } from "#/verbs/office.types.js";

const prName = (repo: RepoRef, number: number) => `${repo.owner}/${repo.name}#${number}`;

/**
 * Notes what the agent made through its verbs in a round: pull requests it opened, updated or merged, and documents
 * it wrote and linked to its work. A `done` hand-back needs something like it to review (`work-done-guard.ts`).
 */
export function producedTracker() {
  const produced: string[] = [];
  const note = (what: string) => {
    if (!produced.includes(what)) {
      produced.push(what);
    }
  };

  /** The code host, with the writes that leave a result to review noted. */
  function vcs(base: Vcs): Vcs {
    const merge = base.mergePullRequest?.bind(base);
    const enqueue = base.enqueue?.bind(base);
    const autoMerge = base.enableAutoMerge?.bind(base);
    return Object.create(base, {
      openPullRequest: {
        value: async (...args: Parameters<Vcs["openPullRequest"]>) => {
          const pr = await base.openPullRequest(...args);
          note(`opened pull request ${prName(args[0], pr.number)}${pr.draft ? " (draft)" : ""}`);
          return pr;
        },
      },
      updatePullRequest: {
        value: async (...args: Parameters<Vcs["updatePullRequest"]>) => {
          const pr = await base.updatePullRequest(...args);
          note(`updated pull request ${prName(args[0], args[1])}${pr.draft ? " (draft)" : ""}`);
          return pr;
        },
      },
      ...(merge && {
        mergePullRequest: {
          value: async (...args: Parameters<NonNullable<Vcs["mergePullRequest"]>>) => {
            const r = await merge(...args);
            const how = r.outcome === "merged" ? "merged" : "queued to merge";
            note(`${how} pull request ${prName(args[0], args[1])}`);
            return r;
          },
        },
      }),
      ...(enqueue && {
        enqueue: {
          value: async (repo: RepoRef, number: number) => {
            await enqueue(repo, number);
            note(`queued pull request ${prName(repo, number)} to merge`);
          },
        },
      }),
      ...(autoMerge && {
        enableAutoMerge: {
          value: async (repo: RepoRef, number: number) => {
            await autoMerge(repo, number);
            note(`set pull request ${prName(repo, number)} to merge`);
          },
        },
      }),
    }) as Vcs;
  }

  /** The office's `docLink`, with each document linked to the work noted. */
  const docLink =
    (base: OfficeClient): OfficeClient["docLink"] =>
    async (request) => {
      await base.docLink(request);
      note(`linked document ${request.doc.url}`);
    };

  return { vcs, docLink, produced: (): string[] => [...produced] };
}
