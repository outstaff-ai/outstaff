import type { PullRequest, Vcs } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { producedTracker } from "#/runner/item-produced.js";
import type { OfficeClient } from "#/verbs/office.types.js";

const repo = { owner: "acme", name: "app" };
const pr = (number: number, draft: boolean) => ({ number, draft }) as PullRequest;

const vcsBase = (extra: Partial<Vcs> = {}) =>
  ({
    openPullRequest: async () => pr(2, true),
    updatePullRequest: async (_r: unknown, n: number) => pr(n, false),
    getPullRequest: async () => pr(1, false),
    ...extra,
  }) as unknown as Vcs;

describe("producedTracker", () => {
  it("notes pull requests opened and updated, once each, and leaves the other calls alone", async () => {
    const made = producedTracker();
    const vcs = made.vcs(vcsBase());
    await vcs.openPullRequest(repo, { head: "feat/x", title: "x", body: "" });
    await vcs.updatePullRequest(repo, 1, { draft: false });
    await vcs.updatePullRequest(repo, 1, { title: "y" });
    await vcs.getPullRequest(repo, 1);
    expect(made.produced()).toEqual([
      "opened pull request acme/app#2 (draft)",
      "updated pull request acme/app#1",
    ]);

    expect(vcs.mergePullRequest).toBeUndefined();
  });

  it("notes merges, queued merges and auto-merges", async () => {
    let outcome: "merged" | "queued" = "merged";
    const made = producedTracker();
    const vcs = made.vcs(
      vcsBase({
        mergePullRequest: async () => ({ outcome }),
        enqueue: async () => {},
        enableAutoMerge: async () => {},
      }),
    );

    await vcs.mergePullRequest!(repo, 1, { method: "merge", sha: "a" });
    outcome = "queued";
    await vcs.mergePullRequest!(repo, 2, { method: "merge", sha: "b" });
    await vcs.enqueue!(repo, 3);
    await vcs.enableAutoMerge!(repo, 4);
    expect(made.produced()).toEqual([
      "merged pull request acme/app#1",
      "queued to merge pull request acme/app#2",
      "queued pull request acme/app#3 to merge",
      "set pull request acme/app#4 to merge",
    ]);
  });

  it("notes a document only once the office linked it", async () => {
    const made = producedTracker();
    let refuse = true;
    const office = {
      docLink: async () => {
        if (refuse) {
          throw new Error("no");
        }
      },
    } as unknown as OfficeClient;

    const link = made.docLink(office);
    const request = { workItemId: "w1", doc: { id: "d1", title: "Plan", url: "https://d/1" } };
    await expect(link(request)).rejects.toThrow("no");
    expect(made.produced()).toEqual([]);
    refuse = false;
    await link(request);
    expect(made.produced()).toEqual(["linked document https://d/1"]);
  });
});
