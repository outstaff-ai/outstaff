import { createFakeVcs } from "@outstaff/core/fakes";
import type { FakeVcs } from "@outstaff/core/fakes";
import type { WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState } from "#/workstate/types.js";

const SAM = "acme-sam[bot]";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("events per head commit", () => {
  let store: Store;
  let vcs: FakeVcs;
  let ws: WorkState;
  let seen: WorkflowEvent[];

  /** The base commit the code host reports for every pull request; none while undefined. */
  let baseSha: string | undefined;

  beforeEach(async () => {
    const clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    vcs = createFakeVcs({ now: clock.now });
    baseSha = undefined;
    const real = vcs.getPullRequest.bind(vcs);
    vcs.getPullRequest = async (repo, number, o) => {
      const pr = await real(repo, number, o);
      return baseSha ? { ...pr, base: { ...pr.base, sha: baseSha } } : pr;
    };

    seen = [];
    ws = await createWorkState({
      store,
      ports: { vcs },
      team: teamConfig(),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const opened = async (mergeable?: ("clean" | "conflicting")[]) => {
    const p = await vcs.seed.pullRequest(REPO, {
      author: { login: SAM, kind: "agent" },
      title: "p",
      ...(mergeable ? { mergeable } : {}),
    });

    await ws.apply(
      {
        type: "pr.opened",
        subject: { pr: { repo: REPO, number: p.number } },
        actor: { kind: "agent", id: "sam" },
        data: {},
      },
      { source: "vcs", externalId: `opened-${p.number}`, trusted: true },
    );

    return p;
  };

  const shas = (type: string) => seen.filter((e) => e.type === type).map((e) => e.data["sha"]);

  it("raises pr.ci_failed for a new head that fails before a rescan saw it pending", async () => {
    const p = await opened();
    await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
    await ws.rescan();

    const pushed = await vcs.seed.push(REPO, p.number, SAM);
    await vcs.seed.check(REPO, pushed.head.sha, { name: "build", status: "failure" });
    await ws.rescan();
    expect(shas("pr.ci_failed")).toEqual([p.head.sha, pushed.head.sha]);
  });

  it("raises pr.ci_passed for a new head that passes before a rescan saw it pending", async () => {
    const p = await opened();
    await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "success" });
    await ws.rescan();

    const pushed = await vcs.seed.push(REPO, p.number, SAM);
    await vcs.seed.check(REPO, pushed.head.sha, { name: "build", status: "success" });
    await ws.rescan();
    expect(shas("pr.ci_passed")).toEqual([p.head.sha, pushed.head.sha]);
  });

  it("raises nothing more when the same head is read again, or its checks run again", async () => {
    const p = await opened();
    await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
    await ws.rescan();
    await ws.rescan();
    await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "pending" });
    await ws.rescan();
    await vcs.seed.check(REPO, p.head.sha, { name: "build", status: "failure" });
    await ws.rescan();
    expect(seen.map((e) => e.type)).toEqual(["pr.ci_failed"]);
  });

  it("raises pr.conflicted again for a pull request that still conflicts on a new head", async () => {
    const p = await opened(["clean", "conflicting"]);
    await ws.rescan();
    const pushed = await vcs.seed.push(REPO, p.number, SAM);
    await ws.rescan();
    await ws.rescan();
    expect(shas("pr.conflicted")).toEqual([p.head.sha, pushed.head.sha]);
  });

  it("raises pr.conflicted again when the base commit moves under a conflicting pull request", async () => {
    baseSha = "base-1";
    const p = await opened(["clean", "conflicting"]);
    await ws.rescan();
    await ws.rescan();
    baseSha = "base-2";
    await ws.rescan();
    await ws.rescan();

    const conflicts = seen.filter((e) => e.type === "pr.conflicted");
    expect(conflicts.map((e) => [e.data["sha"], e.data["baseSha"]])).toEqual([
      [p.head.sha, "base-1"],
      [p.head.sha, "base-2"],
    ]);
  });
});
