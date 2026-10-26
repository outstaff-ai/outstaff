import type { ReplayScenario, ReplayWorld } from "../../replay.types.js";
import { approved, at, ev, pr, ticket } from "./build.js";

const wishlist = pr(60, "Wishlist", { by: "sam", head: "sam/acme-140" });
const links = { 60: "ACME-140" };
const inReview: ReplayWorld = {
  tickets: { "ACME-140": ticket("review", "ada.admin", { lastWorker: "sam" }) },
  prs: [wishlist],
  links,
};

const reworking: ReplayWorld = {
  tickets: { "ACME-140": ticket("active", "sam") },
  prs: [wishlist],
  links,
};

const NO_REACTIVATION =
  "regression: nothing moves ACME-140 back to active or gives it back to sam; the plan makes ticket moves explicit act policies with the act path (phase 2), not in this set";

export const reviewRound: ReplayScenario = {
  title: "A review round: pending comments, a batch of feedback, approval and merge",
  steps: [
    {
      event: ev("s3-pending", "pr.comment", "ada-admin", { pr: 60 }, at(99), {
        kind: "review_comment",
        reviewId: 9,
        body: "This hook does two things.",
      }),
      world: inReview,
    },
    {
      event: ev("s3-changes", "pr.review_submitted", "ada-admin", { pr: 60 }, at(100), {
        state: "changes_requested",
        body: "Please split the store logic out of the hook.",
        comments: [{ path: "src/wishlist.ts", line: 12, body: "This hook does two things." }],
      }),
      world: inReview,
      note: NO_REACTIVATION,
    },
    {
      event: ev("s3-comment-1", "pr.comment", "ada-admin", { pr: 60 }, at(100, 20), {
        kind: "comment",
        body: "Also rename useWish to useWishlist.",
      }),
      world: reworking,
    },
    {
      event: ev("s3-comment-2", "pr.comment", "ada-admin", { pr: 60 }, at(100, 45), {
        kind: "comment",
        body: "And a test for the empty list, please.",
      }),
      world: reworking,
    },
    {
      event: ev("s3-approve-with-nit", "pr.review_submitted", "ada-admin", { pr: 60 }, at(140), {
        state: "approved",
        body: "Looks good. One nit: drop the console.log.",
      }),
      world: { ...inReview, prs: [{ ...wishlist, verdicts: [approved()] }] },
      note: NO_REACTIVATION,
    },
    {
      event: ev("s3-untrusted", "pr.review_submitted", "outside-contributor", { pr: 60 }, at(141), {
        state: "approved",
        body: "",
        untrusted: true,
      }),
      world: { ...reworking, prs: [{ ...wishlist, verdicts: [approved()] }] },
    },
    {
      event: ev(
        "s3-handed-back",
        "agent.handed_back",
        "sam",
        { pr: 60, ticket: "ACME-140" },
        at(150),
        {
          kind: "review_feedback",
          status: "done",
          workItem: "item-60",
        },
      ),
      world: { ...reworking, prs: [{ ...wishlist, verdicts: [approved()] }] },
    },
  ],
};

const savedSearches = pr(61, "Saved searches", { by: "sam", head: "sam/acme-141" });
const copy = pr(54, "Copy fixes", { by: "grace-lead", head: "copy-fixes" });

export const ciFailure: ReplayScenario = {
  title: "Checks fail",
  steps: [
    {
      event: ev("s9-ci-61", "pr.ci_failed", "office", { pr: 61, ticket: "ACME-141" }, at(170), {
        failing: ["test"],
        checks: [{ name: "test", url: "https://github.com/acme-example/shop/actions/runs/1" }],
      }),
      world: {
        tickets: { "ACME-141": ticket("review", "ada.admin", { lastWorker: "sam" }) },
        prs: [savedSearches],
        links: { 61: "ACME-141" },
      },
      note: "intended fix: sam is woken with the failing checks; reassigning and moving ACME-141 is left to sam",
    },
    {
      event: ev("s9-ci-54", "pr.ci_failed", "office", { pr: 54 }, at(171), { failing: ["lint"] }),
      world: { prs: [copy] },
    },
  ],
};

const drafts = pr(62, "Price rounding", { by: "sam", head: "sam/acme-162", draft: true });
const second = pr(63, "Checkout copy", { by: "grace-lead", head: "checkout-copy" });
const checkout = pr(51, "Checkout form", { by: "sam", head: "sam/acme-131" });
const legal = pr(55, "Legal footer", { by: "grace-lead", head: "legal-footer", state: "merged" });
const rates = pr(56, "Rates API", { by: "sam", head: "sam/acme-136", state: "merged" });
const ratesUi = pr(57, "Rates UI", { by: "sam", head: "sam/acme-136-ui" });
const searchApi = pr(41, "Search API", { by: "sam", head: "sam/acme-123", state: "merged" });

export const otherPrEvents: ReplayScenario = {
  title: "Other pull request events",
  steps: [
    {
      event: ev("s11-draft", "pr.opened", "sam", { pr: 62, ticket: "ACME-162" }, at(180)),
      world: {
        tickets: { "ACME-162": ticket("active", "sam") },
        prs: [drafts],
        links: { 62: "ACME-162" },
      },
    },
    {
      event: ev(
        "s11-human-second",
        "pr.opened",
        "grace-lead",
        { pr: 63, ticket: "ACME-131" },
        at(181),
      ),
      world: {
        tickets: { "ACME-131": ticket("active", "sam") },
        prs: [checkout, second],
        links: { 51: "ACME-131", 63: "ACME-131" },
      },
      note: "intended fix: a human's pull request leaves the ticket to that human (there is no agent to act for), and one pull request per ticket is the repository's practice, not the office's",
    },
    {
      event: ev("s11-closed", "pr.closed", "ada-admin", { pr: 62, ticket: "ACME-162" }, at(182)),
      world: {
        tickets: { "ACME-162": ticket("review", "ada.admin", { lastWorker: "sam" }) },
        prs: [{ ...drafts, state: "closed" }],
        links: { 62: "ACME-162" },
      },
      note: "regression: closing a pull request unmerged no longer moves its ticket back to ready; not in the plan's table",
    },
    {
      event: ev(
        "s11-human-merge",
        "pr.merged",
        "grace-lead",
        { pr: 55, ticket: "ACME-135" },
        at(183),
      ),
      world: {
        tickets: { "ACME-135": ticket("review", "grace-lead") },
        prs: [legal],
        links: { 55: "ACME-135" },
      },
      note: "intended fix: there is no agent to act for, so closing the ticket is left to the human who merged",
    },
    {
      event: ev(
        "s11-merge-one-of-two",
        "pr.merged",
        "ada-admin",
        { pr: 56, ticket: "ACME-136" },
        at(184),
      ),
      world: {
        tickets: { "ACME-136": ticket("review", "sam") },
        prs: [rates, ratesUi],
        links: { 56: "ACME-136", 57: "ACME-136" },
      },
    },
    {
      event: ev("s11-merged-feedback", "pr.review_submitted", "ada-admin", { pr: 41 }, at(185), {
        state: "commented",
        body: "Small follow-up: log the query time.",
      }),
      world: {
        tickets: { "ACME-123": ticket("done", "sam") },
        prs: [searchApi],
        links: { 41: "ACME-123" },
      },
    },
    {
      event: ev("s11-agent-review", "pr.comment", "ines", { pr: 60 }, at(186), {
        kind: "comment",
        body: "Reviewed: the empty state needs a test.",
      }),
      world: reworking,
    },
  ],
};
