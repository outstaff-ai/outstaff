import { describe, expect, it } from "vitest";
import {
  actionsJobId,
  authorKind,
  checkRunStatus,
  checkSummary,
  commitStatusState,
  mergeability,
  permissionLevel,
  stripBot,
  toPullRequest,
  toVcsEvent,
} from "../mapping.js";
import type { RestEvent, RestPull } from "../api.types.js";

const REPO = { owner: "acme", name: "app" };

const pull = (over: Partial<RestPull> = {}): RestPull => ({
  number: 3,
  title: "Add login",
  body: "details",
  user: { login: "marcus" },
  head: { ref: "feat/login", sha: "abc" },
  base: { ref: "main" },
  state: "open",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("toPullRequest", () => {
  it("maps a pull request", () => {
    expect(toPullRequest(REPO, pull({ draft: true }), "https://x/pull/3", () => false)).toEqual({
      repo: REPO,
      number: 3,
      title: "Add login",
      body: "details",
      url: "https://x/pull/3",
      author: { login: "marcus", kind: "human" },
      head: { ref: "feat/login", sha: "abc" },
      base: { ref: "main" },
      state: "open",
      draft: true,
      mergeable: "unknown",
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("attributes a deleted user to ghost and an empty body to the empty string", () => {
    const out = toPullRequest(REPO, pull({ user: null, body: null }), "u", () => false);
    expect(out.author).toEqual({ login: "ghost", kind: "human" });
    expect(out.body).toBe("");
  });

  it("reports a pull request merged by flag or by merge time", () => {
    expect(toPullRequest(REPO, pull({ merged: true }), "u", () => false).state).toBe("merged");
    expect(
      toPullRequest(
        REPO,
        pull({ state: "closed", merged_at: "2026-01-02T00:00:00Z" }),
        "u",
        () => false,
      ).state,
    ).toBe("merged");

    expect(toPullRequest(REPO, pull({ state: "closed" }), "u", () => false).state).toBe("closed");
  });
});

describe("authorKind and stripBot", () => {
  it("tells agents, bots and humans apart", () => {
    expect(authorKind("sam[bot]", (l) => l === "sam[bot]")).toBe("agent");
    expect(authorKind("dependabot[bot]", () => false)).toBe("bot");
    expect(authorKind("marcus", () => false)).toBe("human");
    expect(stripBot("sam[bot]")).toBe("sam");
    expect(stripBot("sam")).toBe("sam");
  });
});

describe("mergeability", () => {
  it.each([
    [{ mergeable_state: "dirty", mergeable: true }, "conflicting"],
    [{ mergeable: false }, "conflicting"],
    [{ mergeable: true, mergeable_state: "clean" }, "clean"],
    [{ mergeable: true, mergeable_state: "unknown" }, "unknown"],
    [{ mergeable: null }, "unknown"],
  ] as const)("maps %j to %s", (pr, expected) => {
    expect(mergeability({ ...pull(), ...pr })).toBe(expected);
  });
});

describe("check and status mapping", () => {
  const run = (over: object) => ({ name: "ci", status: "completed", conclusion: null, ...over });

  it.each([
    [{ status: "in_progress" }, "pending"],
    [{ conclusion: "success" }, "success"],
    [{ conclusion: "failure" }, "failure"],
    [{ conclusion: "timed_out" }, "failure"],
    [{ conclusion: "cancelled" }, "failure"],
    [{ conclusion: "action_required" }, "failure"],
    [{ conclusion: "startup_failure" }, "failure"],
    [{ conclusion: "skipped" }, "neutral"],
    [{ conclusion: null }, "neutral"],
  ])("maps check run %j to %s", (over, expected) => {
    expect(checkRunStatus(run(over))).toBe(expected);
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["error", "failure"],
    ["pending", "pending"],
  ] as const)("maps commit status %s to %s", (state, expected) => {
    expect(commitStatusState(state)).toBe(expected);
  });

  it.each([
    ["admin", "admin"],
    ["maintain", "write"],
    ["write", "write"],
    ["triage", "read"],
    ["read", "read"],
    ["other", "none"],
  ] as const)("maps permission %s to %s", (value, expected) => {
    expect(permissionLevel(value)).toBe(expected);
  });
});

describe("actionsJobId and checkSummary", () => {
  const run = { name: "ci", status: "completed", conclusion: "failure" };

  it("reads the job id from the details URL, else from a github-actions run id", () => {
    expect(actionsJobId({ ...run, details_url: "https://h/acme/app/actions/runs/9/job/42" })).toBe(
      "42",
    );

    expect(actionsJobId({ ...run, id: 7, app: { slug: "github-actions" } })).toBe("7");
    expect(actionsJobId({ ...run, id: 7, app: { slug: "other" } })).toBeUndefined();
    expect(actionsJobId({ ...run, app: { slug: "github-actions" } })).toBeUndefined();
  });

  it("prefers the summary, then the title, trims, and cuts long text", () => {
    expect(checkSummary({ ...run, output: { summary: " sum ", title: "t" } })).toBe("sum");
    expect(checkSummary({ ...run, output: { summary: "", title: "t" } })).toBe("t");
    expect(checkSummary({ ...run, output: null })).toBeUndefined();
    expect(checkSummary({ ...run, output: { summary: "x".repeat(600) } })).toBe(
      `${"x".repeat(500)}...`,
    );
  });
});

describe("toVcsEvent edge cases", () => {
  const event = (type: string, payload: Record<string, unknown>, actor?: null): RestEvent => ({
    id: "1",
    type,
    ...(actor === null ? { actor: null } : { actor: { login: "marcus" } }),
    created_at: "2026-01-01T00:00:00Z",
    payload,
  });

  const prPayload = { head: { ref: "h", sha: "s" }, base: { ref: "b" }, title: "T" };

  it("attributes an event without an actor to ghost", () => {
    expect(
      toVcsEvent(
        REPO,
        event("PullRequestEvent", { action: "opened", number: 1, pull_request: prPayload }, null),
      )?.actor,
    ).toBe("ghost");
  });

  it("takes the number from the pull request when the payload has none, and maps every action", () => {
    const type = (action: string, merged?: boolean) =>
      toVcsEvent(
        REPO,
        event("PullRequestEvent", { action, pull_request: { ...prPayload, number: 4, merged } }),
      );

    expect(type("opened")).toMatchObject({ type: "pr.opened", number: 4 });
    expect(type("reopened")).toMatchObject({ type: "pr.opened", data: { reopened: true } });
    expect(type("closed", true)).toMatchObject({ type: "pr.merged" });
    expect(type("closed")).toMatchObject({ type: "pr.closed" });
    expect(type("synchronize")).toMatchObject({ type: "pr.synchronize" });
    expect(type("labeled")).toBeUndefined();
  });

  it("defaults a review without a state or body", () => {
    expect(
      toVcsEvent(
        REPO,
        event("PullRequestReviewEvent", { action: "created", pull_request: { number: 2 } }),
      ),
    ).toMatchObject({ number: 2, data: { state: "", body: "" } });
  });

  it("ignores review comments that were not created, and comments without a body default to empty", () => {
    expect(
      toVcsEvent(
        REPO,
        event("PullRequestReviewCommentEvent", { action: "edited", pull_request: { number: 2 } }),
      ),
    ).toBeUndefined();

    expect(
      toVcsEvent(
        REPO,
        event("PullRequestReviewCommentEvent", { action: "created", pull_request: { number: 2 } }),
      )?.data,
    ).toMatchObject({ kind: "review_comment", body: "" });

    expect(
      toVcsEvent(
        REPO,
        event("IssueCommentEvent", { action: "created", issue: { number: 2, pull_request: {} } }),
      )?.data,
    ).toMatchObject({ kind: "comment", body: "" });
  });

  it("ignores issue comments on plain issues, and unknown event types", () => {
    expect(
      toVcsEvent(REPO, event("IssueCommentEvent", { action: "created", issue: { number: 2 } })),
    ).toBeUndefined();

    expect(toVcsEvent(REPO, event("WatchEvent", {}))).toBeUndefined();
  });
});
