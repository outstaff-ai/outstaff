import { describe, expect, it } from "vitest";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { BUILT_IN_POLICIES } from "#/pipeline/policies/index.js";
import { HUMAN_AUTHOR, judge, OFFICE, onPr, OPTS, prWorld, stateOf } from "./support.js";

const APPROVED = [{ actor: "ada-admin", kind: "human" as const, state: "approved" as const }];
const CHANGES = [
  ...APPROVED,
  { actor: "grace-lead", kind: "human" as const, state: "changes_requested" as const },
];

const approval = (body = "") => onPr("pr.review_submitted", { state: "approved", body });
const WAKE = ["wake sam (merge) on pr acme-example/shop#9"];

describe("merge_ready", () => {
  it("an allowed approver's approval with green checks wakes the author to decide, with the instruction", () => {
    const world = prWorld({ verdicts: APPROVED, ci: "success" });
    expect(judge("merge_ready", approval(), world)).toEqual(WAKE);
    expect(judge("merge_ready", approval("Nice."), prWorld({ verdicts: APPROVED }))).toEqual(WAKE);

    const trace = evaluatePipeline(approval(), stateOf(world), BUILT_IN_POLICIES, OPTS);
    expect(trace.decisions.find((d) => d.policy === "merge_ready")).toMatchObject({
      instruction:
        "#9 (Change 9) is approved and may be ready to merge. Decide whether to merge it now, wait, or coordinate first; follow the repository's instructions on merging.",
    });
  });

  const dropOf = (e: ReturnType<typeof onPr>, world: ReturnType<typeof prWorld>) =>
    evaluatePipeline(e, stateOf(world), BUILT_IN_POLICIES, OPTS)
      .policies.find((p) => p.policy === "merge_ready")!
      .proposals.map((p) => ("reason" in p ? p.reason : ""));

  it("waits for pending or failing checks, and for an approval by an allowed approver", () => {
    expect(dropOf(approval(), prWorld({ verdicts: APPROVED, ci: "pending" }))).toEqual([
      "not ready to merge: its checks are pending: the wake waits for them to pass",
    ]);

    expect(dropOf(approval(), prWorld({ verdicts: APPROVED, ci: "failure" }))).toEqual([
      "not ready to merge: its checks are failure: the wake waits for them to pass",
    ]);

    const graceOnly = { ...OPTS, approvers: ["human:grace-lead"] };
    const notAllowed = evaluatePipeline(
      approval(),
      stateOf(prWorld({ verdicts: [{ ...APPROVED[0]!, actor: "grace-lead" }] })),
      BUILT_IN_POLICIES,
      graceOnly,
    ).policies.find((p) => p.policy === "merge_ready")!;

    expect(notAllowed.proposals).toEqual([
      {
        type: "drop",
        reason:
          "not ready to merge: the review is not an approval by an allowed approver (policies.merge.approvers)",
      },
    ]);

    const comment = onPr("pr.review_submitted", { state: "commented", body: "hm" });
    expect(dropOf(comment, prWorld({ verdicts: APPROVED }))).toEqual([
      "not ready to merge: the review is not an approval by an allowed approver (policies.merge.approvers)",
    ]);
  });

  it("checks turning green, or the base merging, on an approved pull request wake the author", () => {
    const world = prWorld({ verdicts: APPROVED, ci: "success" });
    expect(judge("merge_ready", onPr("pr.ci_passed", {}, OFFICE), world)).toEqual(WAKE);
    expect(judge("merge_ready", onPr("pr.base_merged", {}, OFFICE), world)).toEqual(WAKE);
    expect(
      dropOf(onPr("pr.base_merged", {}, OFFICE), prWorld({ verdicts: APPROVED, ci: "failure" })),
    ).toEqual(["not ready to merge: its checks are failure: the wake waits for them to pass"]);
  });

  it("not without an approval, while changes are requested, for a draft, or for a human's pull request", () => {
    const passed = onPr("pr.ci_passed", {}, OFFICE);
    expect(judge("merge_ready", passed, prWorld({ ci: "success" }))).toEqual({
      failed: { pr_approved: true },
    });

    expect(judge("merge_ready", passed, prWorld({ verdicts: CHANGES }))).toEqual({
      failed: { pr_approved: true },
    });

    expect(judge("merge_ready", passed, prWorld({ verdicts: APPROVED, draft: true }))).toEqual({
      failed: { pr_draft: false },
    });

    expect(
      judge("merge_ready", passed, prWorld({ verdicts: APPROVED, author: HUMAN_AUTHOR })),
    ).toEqual({ failed: { pr_author_kind: "agent" } });
  });

  it("only in the repositories of policies.merge.repos, when the team names some", () => {
    const passed = onPr("pr.ci_passed", {}, OFFICE);
    const world = stateOf(prWorld({ verdicts: APPROVED, ci: "success" }));
    const run = (mergeRepos: string[]) =>
      evaluatePipeline(passed, world, BUILT_IN_POLICIES, { ...OPTS, mergeRepos }).decisions.filter(
        (d) => d.policy === "merge_ready",
      );

    expect(run(["acme-example/shop"])).toHaveLength(1);
    const outside = evaluatePipeline(passed, world, BUILT_IN_POLICIES, {
      ...OPTS,
      mergeRepos: ["acme-example/ops"],
    }).policies.find((p) => p.policy === "merge_ready")!;

    expect(outside.proposals).toEqual([
      {
        type: "drop",
        reason: "not ready to merge: acme-example/shop is not in policies.merge.repos",
      },
    ]);
  });
});
