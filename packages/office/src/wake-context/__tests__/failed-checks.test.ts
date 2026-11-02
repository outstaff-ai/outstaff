import { PortError, type CheckLog } from "@outstaff/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_LIMITS } from "#/pipeline/context/index.js";
import { openStore, type Store } from "#/store/index.js";
import { wakeContextOf } from "#/wake-context/index.js";
import type { MergeChecks, PrRecord } from "#/workstate/index.js";

const REPO = { host: "git.acme.example", owner: "acme", name: "app" };
const KEY = "git.acme.example/acme/app#10";

const merged = (mergeChecks: MergeChecks): PrRecord => ({
  ref: { repo: REPO, number: 10 },
  title: "Deploy config",
  headRef: "sam/acme-1",
  headSha: "head",
  baseRef: "main",
  draft: false,
  state: "merged",
  mergeable: "clean",
  author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
  checks: [],
  ci: "success",
  unresolvedThreads: 0,
  mergeChecks,
  updatedAt: "2026-10-01T09:00:00.000Z",
});

const FAILED: MergeChecks = {
  sha: "abc1234def",
  since: "2026-10-01T09:00:00.000Z",
  state: "failed",
  failing: [
    { name: "deploy", url: "https://git.acme.example/acme/app/actions/runs/7/job/42", logId: "42" },
    { name: "status", url: "https://ci.acme.example/9" },
  ],
};

describe("the log of a check that failed after a merge, in the wake", () => {
  let store: Store;
  let read: (logId: string) => Promise<CheckLog>;
  beforeEach(async () => {
    store = await openStore("sqlite::memory:");
    read = async () => ({
      failedSteps: [
        {
          name: "Deploy",
          lines: [
            "region missing",
            `token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(500)}`,
          ],
          omitted: 80,
        },
      ],
    });
  });

  afterEach(async () => {
    await store.close();
  });

  const wake = async (kind: string, checks: MergeChecks = FAILED) => {
    await store.upsertSubject("pr", KEY, merged(checks));
    const wakeOf = wakeContextOf(
      {
        store,
        vcs: {
          links: { pr: () => "", commit: () => "", thread: () => "" },
          reviewThreads: async () => [],
          checks: async () => [],
          checkLog: (_repo, logId) => read(logId),
        },
      },
      { limits: DEFAULT_CONTEXT_LIMITS },
    );

    const item = await store.enqueue({
      person: "sam",
      kind,
      title: kind,
      trigger: "human",
      subject: { type: "pr", ref: KEY },
    });

    return wakeOf(item, false);
  };

  it("carries the end of each failed step's log, masked and cut, and a note for a check without one", async () => {
    const context = (await wake("merge_checks_failed"))!;
    expect(context.failedChecks).toEqual([
      {
        pr: KEY,
        sha: "abc1234def",
        name: "deploy",
        url: "https://git.acme.example/acme/app/actions/runs/7/job/42",
        steps: [
          {
            name: "Deploy",
            lines: ["region missing", expect.stringMatching(/^token \*+ x+ \.\.\. \(cut\)$/)],
            omitted: 80,
          },
        ],
      },
      {
        pr: KEY,
        sha: "abc1234def",
        name: "status",
        url: "https://ci.acme.example/9",
        steps: [],
        note: "No step log is available for this check; see its link.",
      },
    ]);

    expect(context.failedChecks![0]!.steps[0]!.lines[1]!.length).toBeLessThan(420);
  });

  it("says why when the log cannot be read or shows no failed step", async () => {
    read = async () => {
      throw new PortError("forbidden", "Actions: read is missing");
    };

    expect((await wake("merge_checks_failed"))!.failedChecks![0]!.note).toBe(
      "The office could not read the log: Actions: read is missing",
    );

    read = async () => ({ failedSteps: [] });
    expect((await wake("merge_checks_failed"))!.failedChecks![0]!.note).toContain("no failed step");
  });

  it("names a check still running at the timeout without reading a log", async () => {
    const timedOut: MergeChecks = { ...FAILED, failing: [FAILED.failing![0]!], timedOut: true };
    expect((await wake("merge_checks_failed", timedOut))!.failedChecks).toEqual([
      expect.objectContaining({
        timedOut: true,
        steps: [],
        note: expect.stringContaining("still running"),
      }),
    ]);
  });

  it("leaves out what the merge does not say", async () => {
    const bare: MergeChecks = {
      since: FAILED.since,
      state: "failed",
      failing: [{ name: "deploy" }],
    };

    expect((await wake("merge_checks_failed", bare))!.failedChecks).toEqual([
      { pr: KEY, name: "deploy", steps: [], note: expect.stringContaining("No step log") },
    ]);

    const none: MergeChecks = { since: FAILED.since, state: "failed" };
    expect((await wake("merge_checks_failed", none))?.failedChecks).toBeUndefined();
  });

  it("carries nothing for other kinds, or a merge whose checks did not fail", async () => {
    expect((await wake("rebase"))?.failedChecks).toBeUndefined();
    expect(
      (await wake("merge_checks_failed", { ...FAILED, state: "passed" }))?.failedChecks,
    ).toBeUndefined();
  });
});
