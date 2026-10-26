import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toVcsEvent, type RestEvent } from "../mapping.js";

// Trimmed from real payloads of the repository events feed (not webhooks), with names replaced.
const fixture = (name: string): RestEvent =>
  JSON.parse(
    readFileSync(new URL(`../testing/fixtures/events-feed/${name}.json`, import.meta.url), "utf8"),
  );

const REPO = { owner: "acme", name: "app" };
const map = (name: string) => toVcsEvent(REPO, fixture(name));

describe("events feed payloads", () => {
  it("maps PullRequestEvent opened", () => {
    expect(map("pull-request-opened")).toMatchObject({
      type: "pr.opened",
      number: 8,
      actor: "marcus",
      data: { headRef: "feat/login", baseRef: "main" },
    });
  });

  it("maps PullRequestEvent merged, which the feed sends as its own action", () => {
    expect(map("pull-request-merged")).toMatchObject({ type: "pr.merged", number: 8 });
  });

  it("maps PullRequestEvent closed without a merge", () => {
    expect(map("pull-request-closed")).toMatchObject({ type: "pr.closed", number: 8 });
  });

  it.each([
    ["pull-request-review-approved", "approved", ""],
    ["pull-request-review-commented", "commented", "Please add a test for the empty case."],
    ["pull-request-review-changes-requested", "changes_requested", "This breaks the login flow."],
  ])("maps PullRequestReviewEvent created: %s", (name, state, body) => {
    expect(map(name)).toMatchObject({
      type: "pr.review_submitted",
      number: 8,
      actor: "noor",
      data: { state, body },
    });
  });

  it("ignores a dismissed review", () => {
    expect(map("pull-request-review-dismissed")).toBeUndefined();
  });

  it("still maps a webhook-style submitted review", () => {
    const e = fixture("pull-request-review-commented");
    e.payload["action"] = "submitted";
    expect(toVcsEvent(REPO, e)).toMatchObject({ type: "pr.review_submitted" });
  });

  it("maps PullRequestReviewCommentEvent", () => {
    expect(map("pull-request-review-comment")).toMatchObject({
      type: "pr.comment",
      number: 8,
      data: {
        kind: "review_comment",
        path: "src/login.ts",
        body: "Nit: rename this to `session`.",
      },
    });
  });

  it("carries the review an inline comment belongs to, so the office can wait for its submission", () => {
    const e = fixture("pull-request-review-comment");
    expect(toVcsEvent(REPO, e)).toMatchObject({
      data: { kind: "review_comment", reviewId: 5600000010 },
    });

    delete e.payload["comment"]["pull_request_review_id"];
    expect(toVcsEvent(REPO, e)?.data).not.toHaveProperty("reviewId");
  });

  it("maps IssueCommentEvent on a pull request", () => {
    expect(map("issue-comment-on-pull-request")).toMatchObject({
      type: "pr.comment",
      number: 8,
      data: { kind: "comment", body: "Can you rebase on main?" },
    });
  });

  it("does not map PushEvent (the feed carries no commits) or check events (the feed has none)", () => {
    expect(map("push")).toBeUndefined();
  });
});
