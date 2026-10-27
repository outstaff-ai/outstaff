import { describe, expect, it } from "vitest";
import { deriveAfterMerge } from "#/pipeline/derive.js";
import type { PrSnapshot } from "#/pipeline/derive.types.js";
import { prRef } from "./support.js";

const snap = (number: number, o: Partial<PrSnapshot> = {}): PrSnapshot => ({
  ref: prRef(number),
  title: `Change ${number}`,
  headRef: `branch-${number}`,
  baseRef: "main",
  state: "open",
  mergeable: "clean",
  ...o,
});

const merged = snap(50, {
  state: "merged",
  title: "Cart totals",
  url: "https://github.com/acme-example/shop/pull/50",
});

const AT = "2026-10-05T10:00:00.000Z";
const types = (events: ReturnType<typeof deriveAfterMerge>) =>
  events.map((e) => `${e.type} #${e.subject.pr!.number}`);

const UP_TO_DATE = { branch: "main", upToDate: true };

describe("deriveAfterMerge", () => {
  it("raises an event for every open pull request the merge changed something under, naming the merge", () => {
    const after = [
      merged,
      snap(51, { mergeable: "conflicting", ticket: "ACME-131" }),
      snap(52, { mergeable: "conflicting" }),
      snap(53),
      snap(54, { baseRef: "branch-50" }),
      snap(55, { baseRef: "branch-x", mergeable: "conflicting" }),
      snap(56, { baseRef: "branch-y", mergeable: "conflicting" }),
      snap(57, { baseRef: "branch-z" }),
    ];

    const before = [
      snap(52, { mergeable: "conflicting" }),
      snap(56, { baseRef: "branch-y", mergeable: "conflicting" }),
    ];

    const events = deriveAfterMerge({ merged, before, after, requirements: UP_TO_DATE, at: AT });
    expect(types(events)).toEqual([
      "pr.conflicted #51",
      "pr.conflicted #52",
      "pr.behind_base #53",
      "pr.base_merged #54",
      "pr.conflicted #55",
    ]);

    expect(events[0]).toEqual({
      id: "derived:pr.conflicted:acme-example/shop#51:after:acme-example/shop#50",
      type: "pr.conflicted",
      at: AT,
      subject: { pr: prRef(51), ticket: "ACME-131" },
      actor: { kind: "automation", id: "office" },
      data: {
        cause: {
          pr: prRef(50),
          title: "Cart totals",
          url: "https://github.com/acme-example/shop/pull/50",
        },
        base: "main",
      },
    });

    expect(events[1]!.subject).toEqual({ pr: prRef(52) });
  });

  it("raises no behind-base event unless the host requires branches into that base to be up to date", () => {
    const events = deriveAfterMerge({
      merged,
      before: [],
      after: [merged, snap(53)],
      requirements: { branch: "main", upToDate: false },
      at: AT,
    });

    expect(events).toEqual([]);

    // The requirement read is for the default branch; a merge into another base says nothing about it.
    const elsewhere = deriveAfterMerge({
      merged,
      before: [],
      after: [merged, snap(53)],
      requirements: { branch: "trunk", upToDate: true },
      at: AT,
    });

    expect(elsewhere).toEqual([]);
  });

  it("leaves closed pull requests and other repositories alone", () => {
    const other = {
      ...snap(60, { mergeable: "conflicting" }),
      ref: { repo: { host: "github.com", owner: "acme-example", name: "infra" }, number: 60 },
    };

    const closed = snap(61, { state: "closed", mergeable: "conflicting" });
    const named = {
      ...snap(62, { mergeable: "conflicting" }),
      ref: { repo: { host: "github.com", owner: "acme-other", name: "shop" }, number: 62 },
    };

    expect(
      deriveAfterMerge({
        merged,
        before: [],
        after: [other, closed, named],
        requirements: UP_TO_DATE,
        at: AT,
      }),
    ).toEqual([]);
  });
});
