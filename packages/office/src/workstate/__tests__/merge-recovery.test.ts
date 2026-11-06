import {
  createFakeTracker,
  createFakeVcs,
  type FakeTracker,
  type FakeVcs,
} from "@outstaff/core/fakes";
import { PortError, type Check, type PrRef, type WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { recoveredBy } from "#/workstate/merge-recovery.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState, WorkstateMeta } from "#/workstate/types.js";

const SAM = "acme-sam[bot]";
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const meta = (id: string): WorkstateMeta => ({ source: "vcs", externalId: id, trusted: true });
const prRef = (number: number): PrRef => ({ repo: REPO, number });

const check = (name: string, status: Check["status"], workflow?: string): Check => ({
  name,
  status,
  url: `https://ci.acme.example/${name}`,
  ...(workflow ? { workflow } : {}),
});

describe("recoveredBy", () => {
  const deploy = [{ name: "deploy", workflow: "Deploy" }];

  it("passes when every failed check passed, in the same workflow when both name one", () => {
    expect(recoveredBy(deploy, [check("deploy", "success", "Deploy")])).toBe("passed");
    expect(recoveredBy(deploy, [check("deploy", "success")])).toBe("passed");
    expect(recoveredBy([{ name: "deploy" }], [check("deploy", "success", "Other")])).toBe("passed");
  });

  it("waits while one still runs, and does not pass a check that failed, did not run or ran elsewhere", () => {
    expect(recoveredBy(deploy, [check("deploy", "pending", "Deploy")])).toBe("running");
    expect(recoveredBy(deploy, [check("deploy", "failure", "Deploy")])).toBe("not");
    expect(recoveredBy(deploy, [check("build", "success", "Deploy")])).toBe("not");
    expect(recoveredBy(deploy, [check("deploy", "success", "Other")])).toBe("not");
  });
});

describe("work state: a failed merge that passes later on the default branch", () => {
  let clock: ManualClock;
  let store: Store;
  let vcs: FakeVcs;
  let tracker: FakeTracker;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  let n = 0;

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    vcs = createFakeVcs({ now: clock.now });
    tracker = createFakeTracker({ now: clock.now });
    seen = [];
    ws = await createWorkState({
      store,
      ports: { vcs, tracker },
      team: teamConfig({
        policies: { merge_checks: { wait_for_start_minutes: 1, settle_minutes: 0 } },
      }),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  });

  afterEach(async () => {
    await ws.stop();
    await store.close();
  });

  const apply = (type: WorkflowEvent["type"], number: number) =>
    ws.apply(
      { type, subject: { pr: prRef(number) }, actor: { kind: "human", id: "dana" }, data: {} },
      meta(`e${++n}`),
    );

  /** sam's pull request for a ticket, merged, whose deploy fails on the merge commit. */
  const failedMerge = async (status: "blocked" | "done" = "blocked") => {
    const { key } = await tracker.createIssue({ title: "Deploy", body: "", status });
    const p = await vcs.seed.pullRequest(REPO, {
      author: { login: SAM, kind: "agent" },
      title: "Deploy config",
      body: `Closes ${key}`,
    });

    await apply("pr.opened", p.number);
    const done = await vcs.seed.merge(REPO, p.number, "dana");
    const sha = done.mergeCommitSha!;
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "failure", workflow: "Deploy" });
    await apply("pr.merged", p.number);
    return { key, number: p.number, sha };
  };

  const recovered = () =>
    seen
      .filter((e) => e.type === "pr.merge_checks_passed")
      .map((e) => ({
        number: e.subject.pr?.number,
        ticket: e.subject.ticket,
        ...e.data,
        at: undefined,
      }));

  it("raises pr.merge_checks_passed with recoveredOn once the check passes on a later commit that contains the merge", async () => {
    const { key, number, sha } = await failedMerge();
    expect(seen.map((e) => e.type)).toContain("pr.merge_checks_failed");

    const later = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, later, { name: "deploy", status: "pending", workflow: "Deploy" });
    await ws.followMerges();
    expect(recovered()).toEqual([]);

    await vcs.seed.check(REPO, later, { name: "deploy", status: "success", workflow: "Deploy" });
    await ws.followMerges();
    await ws.followMerges();
    expect(recovered()).toEqual([
      {
        number,
        ticket: key,
        sha,
        base: "main",
        recoveredOn: later,
        recovered: [{ name: "deploy", url: expect.stringContaining("deploy") }],
        url: expect.stringContaining(`/pull/${number}`),
        at: undefined,
      },
    ]);

    expect(ws.pullRequests(number)[0]!.mergeChecks).toMatchObject({
      state: "passed",
      recoveredOn: later,
    });
  });

  it("raises nothing for a later commit that does not contain the merge, and looks at a head once", async () => {
    const { sha } = await failedMerge();
    const before = await vcs.seed.commit!(REPO, "main", { from: "0".repeat(40) });
    await vcs.seed.check(REPO, before, { name: "deploy", status: "success", workflow: "Deploy" });
    await ws.followMerges();
    expect(recovered()).toEqual([]);

    const contains = vcs.contains!.bind(vcs);
    let asked = 0;
    vcs.contains = async (...args) => (asked++, contains(...args));
    await ws.followMerges();
    expect(asked).toBe(0);
    expect(await contains(REPO, before, sha)).toBe(false);
  });

  it("raises nothing when another check passes, or the same name in another workflow", async () => {
    await failedMerge();
    const later = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, later, { name: "build", status: "success", workflow: "Deploy" });
    await ws.followMerges();
    const next = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, next, { name: "deploy", status: "success", workflow: "Nightly" });
    await ws.followMerges();
    expect(recovered()).toEqual([]);
  });

  it("stops following once the ticket is closed", async () => {
    await failedMerge("done");
    const later = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, later, { name: "deploy", status: "success", workflow: "Deploy" });
    await ws.followMerges();
    expect(recovered()).toEqual([]);
  });

  it("tries again when the head or the ancestry cannot be read, and skips a host without them", async () => {
    await failedMerge();
    const later = await vcs.seed.commit!(REPO, "main");
    await vcs.seed.check(REPO, later, { name: "deploy", status: "success", workflow: "Deploy" });
    const [head, contains, checks] = [vcs.branchHead!, vcs.contains!, vcs.checks];
    const down = () => Promise.reject(new PortError("unavailable", "down"));
    vcs.branchHead = down;
    await ws.followMerges();
    vcs.branchHead = head;
    vcs.contains = down;
    await ws.followMerges();
    vcs.contains = contains;
    vcs.checks = down;
    await ws.followMerges();
    vcs.checks = checks;
    delete vcs.branchHead;
    await ws.followMerges();
    expect(recovered()).toEqual([]);

    vcs.branchHead = head;
    await ws.followMerges();
    expect(recovered().map((e) => (e as { recoveredOn?: string }).recoveredOn)).toEqual([later]);
  });
});
