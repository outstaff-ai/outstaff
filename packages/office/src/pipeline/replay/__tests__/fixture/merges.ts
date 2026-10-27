import type { ReplayScenario } from "#/pipeline/replay/replay.types.js";
import { approved, at, ev, pr, ticket } from "./build.js";

const searchApi = pr(41, "Search API", { by: "sam", head: "sam/acme-123" });
const searchPage = pr(42, "Search page", { by: "sam", head: "sam/acme-124", base: "sam/acme-123" });
const filters = pr(43, "Search filters", { by: "sam", head: "sam/acme-125", base: "sam/acme-124" });
const stackLinks = { 41: "ACME-123", 42: "ACME-124", 43: "ACME-124" };

export const stackedMerge: ReplayScenario = {
  title: "A stacked pull request series merges",
  steps: [
    {
      event: ev("s1-open-41", "pr.opened", "sam", { pr: 41, ticket: "ACME-123" }, at(0)),
      world: {
        tickets: { "ACME-123": ticket("active", "sam") },
        prs: [searchApi],
        links: stackLinks,
      },
    },
    {
      event: ev("s1-open-42", "pr.opened", "sam", { pr: 42, ticket: "ACME-124" }, at(5)),
      world: {
        tickets: { "ACME-123": ticket("review", "sam"), "ACME-124": ticket("active", "sam") },
        prs: [searchApi, searchPage],
        links: stackLinks,
      },
    },
    {
      event: ev("s1-merge-43", "pr.merged", "ada-admin", { pr: 43, ticket: "ACME-124" }, at(20)),
      world: {
        tickets: { "ACME-123": ticket("review", "sam"), "ACME-124": ticket("review", "sam") },
        prs: [searchApi, searchPage, { ...filters, state: "merged" }],
        links: stackLinks,
      },
    },
    {
      event: ev("s1-approve-41", "pr.review_submitted", "ada-admin", { pr: 41 }, at(30), {
        state: "approved",
        body: "",
      }),
      world: {
        tickets: { "ACME-123": ticket("review", "sam"), "ACME-124": ticket("review", "sam") },
        prs: [{ ...searchApi, verdicts: [approved()] }, searchPage],
        links: stackLinks,
      },
    },
    {
      event: ev("s1-merge-41", "pr.merged", "sam", { pr: 41, ticket: "ACME-123" }, at(40)),
      world: {
        tickets: { "ACME-123": ticket("review", "sam"), "ACME-124": ticket("review", "sam") },
        prs: [{ ...searchApi, state: "merged" }, searchPage],
        links: stackLinks,
      },
      merge: {
        notes: {
          "derived:pr.base_merged:acme-example/shop#42:after:acme-example/shop#41":
            "intended fix: sam hears at once that #42's base merged, naming #41; today nothing happens until #42 conflicts",
        },
      },
    },
  ],
};

const cart = pr(50, "Cart totals", { by: "noor", head: "noor/acme-130" });
const checkout = pr(51, "Checkout form", { by: "sam", head: "sam/acme-131" });
const cache = pr(52, "CI cache", { by: "kofi", head: "kofi/acme-132" });
const events = pr(53, "Order events", { by: "mira", head: "mira/acme-133" });
const copy = pr(54, "Copy fixes", { by: "grace-lead", head: "copy-fixes" });

export const unrelatedConflict: ReplayScenario = {
  title: "Another agent's merge changes the base under unrelated pull requests",
  steps: [
    {
      event: ev("s2-merge-50", "pr.merged", "ada-admin", { pr: 50, ticket: "ACME-130" }, at(60)),
      world: {
        tickets: {
          "ACME-130": ticket("review", "ada.admin"),
          "ACME-131": ticket("review", "ada.admin", { lastWorker: "sam" }),
          "ACME-132": ticket("active", "kofi"),
          "ACME-133": ticket("review", "ada.admin"),
        },
        prs: [{ ...cart, state: "merged" }, checkout, cache, events, copy],
        links: { 50: "ACME-130", 51: "ACME-131", 52: "ACME-132", 53: "ACME-133" },
      },
      merge: {
        before: { 52: "conflicting" },
        after: { 51: "conflicting", 52: "conflicting", 54: "conflicting" },
        requiresUpToDate: true,
        notes: {
          "derived:pr.conflicted:acme-example/shop#51:after:acme-example/shop#50":
            "intended fix: sam is woken and told #50 caused it; reassigning and moving ACME-131 is left to sam, and nothing is commented",
          "derived:pr.conflicted:acme-example/shop#52:after:acme-example/shop#50":
            "intended fix: #52 conflicted already, but against an older main; today the new conflict is ignored",
          "derived:pr.behind_base:acme-example/shop#53:after:acme-example/shop#50":
            "intended fix: the repository requires up-to-date branches, so mira is told to update #53; today she finds out when the merge is refused",
        },
      },
    },
  ],
};
