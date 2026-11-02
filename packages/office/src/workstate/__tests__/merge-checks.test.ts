import { createFakeTracker, createFakeVcs, type FakeVcs } from "@outstaff/core/fakes";
import { PortError, type Check, type PrRef, type WorkflowEvent } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "#/clock.js";
import { REPO, teamConfig } from "#/intake/__tests__/test-support.js";
import { openStore } from "#/store/open.js";
import type { Store } from "#/store/types.js";
import type { ManualClock } from "#/types.js";
import { decideMergeChecks } from "#/workstate/merge-checks.js";
import { createWorkState } from "#/workstate/workstate.js";
import type { WorkState, WorkstateMeta } from "#/workstate/types.js";

const SAM = "acme-sam[bot]";
const MINUTE = 60_000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const meta = (id: string): WorkstateMeta => ({ source: "vcs", externalId: id, trusted: true });
const prRef = (number: number): PrRef => ({ repo: REPO, number });

const check = (name: string, status: Check["status"]): Check => ({
  name,
  status,
  url: `https://ci.acme.example/${name}`,
});

describe("decideMergeChecks", () => {
  const waits = { startMs: 5 * MINUTE, timeoutMs: 120 * MINUTE };

  it("fails at once on a failed check, naming only the failed ones", () => {
    expect(
      decideMergeChecks([check("deploy", "failure"), check("lint", "pending")], 0, waits),
    ).toEqual({
      state: "failed",
      failing: [{ name: "deploy", url: "https://ci.acme.example/deploy" }],
    });
  });

  it("waits for a running check, then fails it at the timeout", () => {
    const running = [check("deploy", "pending"), check("lint", "success")];
    expect(decideMergeChecks(running, 119 * MINUTE, waits)).toBeUndefined();
    expect(decideMergeChecks(running, 120 * MINUTE, waits)).toEqual({
      state: "failed",
      failing: [{ name: "deploy", url: "https://ci.acme.example/deploy" }],
      timedOut: true,
    });
  });

  it("waits for a first check, and passes when none starts", () => {
    expect(decideMergeChecks([], 4 * MINUTE, waits)).toBeUndefined();
    expect(decideMergeChecks([], 5 * MINUTE, waits)).toEqual({ state: "passed" });
  });

  it("is quiet once every check finished green, skipped or neutral, naming them", () => {
    expect(
      decideMergeChecks([check("docs", "neutral"), check("deploy", "success")], 0, waits),
    ).toEqual({ state: "quiet", checks: ["deploy", "docs"] });
  });
});

describe("work state: the checks on a merge commit", () => {
  let clock: ManualClock;
  let store: Store;
  let vcs: FakeVcs;
  let ws: WorkState;
  let seen: WorkflowEvent[];
  let n = 0;

  /** Checks that finished pass at once (`settle_minutes: 0`), unless a test asks for a settle time. */
  const build = async (settle = 0) => {
    ws = await createWorkState({
      store,
      ports: { vcs, tracker: createFakeTracker({ now: clock.now }) },
      team: teamConfig({
        policies: { merge_checks: { wait_for_start_minutes: 1, settle_minutes: settle } },
      }),
      clock,
      logger: silent,
    });

    ws.onEvent((e) => void seen.push(e));
  };

  beforeEach(async () => {
    clock = manualClock();
    store = await openStore("sqlite::memory:", { now: () => clock.now() });
    vcs = createFakeVcs({ now: clock.now });
    seen = [];
    await build();
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

  /** An agent's pull request into `base`, merged, with the events the office hears. */
  const merged = async (base = "main") => {
    const p = await vcs.seed.pullRequest(REPO, {
      author: { login: SAM, kind: "agent" },
      title: "Deploy config",
      base: { ref: base },
    });

    await apply("pr.opened", p.number);
    const done = await vcs.seed.merge(REPO, p.number, "dana");
    return { number: p.number, sha: done.mergeCommitSha! };
  };

  const decided = () =>
    seen
      .filter((e) => e.type.startsWith("pr.merge_checks_"))
      .map((e) => ({ type: e.type, number: e.subject.pr?.number, ...e.data, at: undefined }));

  it("raises nothing on the merge itself, then fails once when a check on the merge commit fails", async () => {
    const { number, sha } = await merged();
    await apply("pr.merged", number);
    expect(decided()).toEqual([]);

    await vcs.seed.check(REPO, sha, { name: "deploy", status: "failure" });
    await ws.followMerges();
    await ws.followMerges();
    expect(decided()).toEqual([
      {
        type: "pr.merge_checks_failed",
        number,
        sha,
        base: "main",
        failing: [{ name: "deploy", url: expect.stringContaining("deploy") }],
        url: expect.stringContaining(`/pull/${number}`),
        at: undefined,
      },
    ]);

    expect(ws.pullRequests(number)[0]!.mergeChecks).toMatchObject({ state: "failed", sha });
  });

  it("decides at once when the checks are there with the merge", async () => {
    const { number, sha } = await merged();
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "success" });
    await apply("pr.merged", number);
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_passed"]);
  });

  it("waits for a workflow that starts after the first checks finish green", async () => {
    await ws.stop();
    await build(1);
    const { number, sha } = await merged();
    await vcs.seed.check(REPO, sha, { name: "build", status: "success" });
    await apply("pr.merged", number);
    expect(ws.pullRequests(number)[0]!.mergeChecks?.quiet).toMatchObject({ checks: ["build"] });

    clock.advance(30_000);
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "pending" });
    await ws.followMerges();
    expect(ws.pullRequests(number)[0]!.mergeChecks?.quiet).toBeUndefined();

    clock.advance(40_000);
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "success" });
    await ws.followMerges();
    clock.advance(59_000);
    await ws.followMerges();
    expect(decided()).toEqual([]);

    clock.advance(1_000);
    await ws.followMerges();
    await ws.followMerges();
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_passed"]);
  });

  it("fails on a late workflow that fails within the settle time, and keeps counting across a restart", async () => {
    await ws.stop();
    await build(1);
    const { number, sha } = await merged();
    await vcs.seed.check(REPO, sha, { name: "build", status: "success" });
    await apply("pr.merged", number);
    await ws.stop();
    await build(1);

    clock.advance(30_000);
    await ws.followMerges();
    expect(ws.pullRequests(number)[0]!.mergeChecks?.quiet?.since).toBe(
      new Date(clock.now().getTime() - 30_000).toISOString(),
    );

    await vcs.seed.check(REPO, sha, { name: "deploy", status: "failure" });
    await ws.followMerges();
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_failed"]);
    expect(ws.pullRequests(number)[0]!.mergeChecks?.quiet).toBeUndefined();
  });

  it("passes a merge with no checks once the wait for a first one is over", async () => {
    const { number } = await merged();
    await apply("pr.merged", number);
    clock.advance(59_000);
    await ws.followMerges();
    expect(decided()).toEqual([]);

    clock.advance(1_000);
    await ws.followMerges();
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_passed"]);
  });

  it("follows a merge across a restart, from the store", async () => {
    const { number, sha } = await merged();
    await apply("pr.merged", number);
    await ws.stop();
    await build();

    await vcs.seed.check(REPO, sha, { name: "deploy", status: "success" });
    await ws.followMerges();
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_passed"]);
  });

  it("follows on the clock once started", async () => {
    const { number, sha } = await merged();
    await apply("pr.merged", number);
    await ws.start();
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "failure" });
    clock.advance(60_000);
    await ws.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_failed"]);
  });

  it("keeps following when the checks cannot be read for a while", async () => {
    const { number, sha } = await merged();
    const checks = vcs.checks.bind(vcs);
    vcs.checks = () => Promise.reject(new PortError("unavailable", "down"));
    await apply("pr.merged", number);
    expect(decided()).toEqual([]);

    vcs.checks = checks;
    await vcs.seed.check(REPO, sha, { name: "deploy", status: "success" });
    await ws.followMerges();
    expect(decided().map((e) => e.type)).toEqual(["pr.merge_checks_passed"]);
  });

  it("does not follow a merge into another branch, nor one it first sees long after", async () => {
    const stacked = await merged("feat/base");
    await apply("pr.merged", stacked.number);

    const old = await vcs.seed.pullRequest(REPO, {
      author: { login: SAM, kind: "agent" },
      title: "Old work",
    });

    await vcs.seed.merge(REPO, old.number, "dana");
    await apply("pr.comment", old.number);

    clock.advance(10 * MINUTE);
    await ws.followMerges();
    expect(decided()).toEqual([]);
    expect(ws.pullRequests(stacked.number)[0]!.mergeChecks).toBeUndefined();
    expect(ws.pullRequests(old.number)[0]!.mergeChecks).toBeUndefined();
  });

  it("passes a merge at once when the code host names no merge commit", async () => {
    const p = await vcs.seed.pullRequest(REPO, {
      author: { login: SAM, kind: "agent" },
      title: "No commit",
    });

    await apply("pr.opened", p.number);
    await vcs.seed.merge(REPO, p.number, "dana");
    const read = vcs.getPullRequest.bind(vcs);
    vcs.getPullRequest = async (...args) => {
      const { mergeCommitSha: _sha, ...rest } = await read(...args);
      return rest;
    };

    await apply("pr.merged", p.number);
    expect(decided()).toEqual([
      {
        type: "pr.merge_checks_passed",
        number: p.number,
        base: "main",
        url: expect.any(String),
        at: undefined,
      },
    ]);
  });
});
