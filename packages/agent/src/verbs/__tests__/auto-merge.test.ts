import { PortError } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { autoMergeWhenReady } from "#/verbs/auto-merge.js";
import { fakeEnv } from "@outstaff/testing.agent";

async function setup(merge: Record<string, unknown> | undefined = { on_approval: true }) {
  const f = fakeEnv();
  const repo = f.vcs.seed.repo;
  f.env.team.repos[0]!.url = `${repo.host}/${repo.owner}/${repo.name}`;
  f.env.team.policies!.merge = { approvers: ["humans"], on_approval: false, ...merge } as never;
  await f.vcs.seed.permission(repo, "sam", "write");
  const pr = await f.vcs.seed.pullRequest(repo, {
    title: "Mine",
    author: { login: "sam", kind: "agent" },
  });

  const ready = (over = {}) => autoMergeWhenReady(f.env, f.vcs, repo, { ...pr, ...over });
  const autoMerge = async () => (await f.vcs.getPullRequest(repo, pr.number)).autoMerge ?? false;
  return { ...f, repo, pr, ready, autoMerge };
}

describe("autoMergeWhenReady", () => {
  it("turns on auto-merge for a ready pull request when the team lets agents", async () => {
    const f = await setup();
    expect(await f.ready()).toMatch(/^Auto-merge is on/);
    expect(await f.autoMerge()).toBe(true);
  });

  it("does nothing when merging is off, outside policies.merge.repos, or for a draft or closed pull request", async () => {
    const off = await setup({ on_approval: false });
    expect(await off.ready()).toBeUndefined();
    const scoped = await setup({ on_approval: true, repos: ["infra"] });
    expect(await scoped.ready()).toBeUndefined();
    const f = await setup();
    expect(await f.ready({ draft: true })).toBeUndefined();
    expect(await f.ready({ state: "closed" })).toBeUndefined();
    expect(await f.autoMerge()).toBe(false);

    const listed = await setup({ on_approval: true, repos: ["shop"] });
    expect(await listed.ready()).toMatch(/^Auto-merge is on/);
    listed.env.team.repos[0]!.url = "git.acme.example/acme/elsewhere";
    expect(await listed.ready()).toBeUndefined();
  });

  it("joins the merge queue where the repository has one", async () => {
    const f = await setup();
    await f.vcs.seed.mergeSettings!(f.repo, { queue: true });
    expect(await f.ready()).toMatch(/^Added to the merge queue/);
  });

  it("falls back to auto-merge when the queue does not take the pull request yet", async () => {
    const f = await setup();
    await f.vcs.seed.mergeSettings!(f.repo, { queue: true });
    f.vcs.enqueue = async () => {
      throw new PortError("invalid", "not approved yet");
    };

    expect(await f.ready()).toMatch(/^Auto-merge is on/);
  });

  it("reports a refusal without failing, and names a host that cannot", async () => {
    const f = await setup();
    await f.vcs.seed.mergeSettings!(f.repo, { queue: true });
    f.vcs.enqueue = async () => {
      throw new PortError("forbidden", "No grant.");
    };

    expect(await f.ready()).toBe(
      "Auto-merge was not turned on: No grant. Do not merge it another way; a person merges it.",
    );

    const { enableAutoMerge: _a, ...without } = f.vcs;
    expect(await autoMergeWhenReady(f.env, without, f.repo, f.pr)).toMatch(/not available/);
  });
});
