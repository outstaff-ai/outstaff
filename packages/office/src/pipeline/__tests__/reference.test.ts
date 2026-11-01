import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_POLICIES, POLICY_SWITCH_OF } from "#/pipeline/policies/index.js";
import { renderPolicyReference } from "#/pipeline/reference.js";
import { conditionLines } from "#/pipeline/reference-parts.js";

describe("the pipeline policies reference", () => {
  it("matches the committed page (run `pnpm --filter @outstaff/office run docs:pipeline`)", () => {
    const committed = readFileSync(
      new URL(
        "../../../../../docs/src/content/docs/reference/pipeline-policies.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(committed).toBe(renderPolicyReference(BUILT_IN_POLICIES, POLICY_SWITCH_OF));
  });

  it("lists every built-in policy with its switch and instruction", () => {
    const page = renderPolicyReference(BUILT_IN_POLICIES, POLICY_SWITCH_OF);
    for (const p of BUILT_IN_POLICIES) {
      expect(page).toContain(`### ${p.id}`);
      expect(page).toContain(p.summary);
    }

    expect(page).toContain("On only while `policies.pull_ready` is on.");
    expect(page).toContain("When: always.");
    expect(page).toContain("Note posted with the change:");
  });

  it("says when a policy that acts posts no note", () => {
    const page = renderPolicyReference(
      [
        {
          id: "silent",
          summary: "s",
          on: ["agent.started"],
          decides: "act for `actor`: move the ticket to `active`",
          decide: () => [],
        },
        {
          id: "acts_then_wakes",
          summary: "s",
          on: ["ticket.moved"],
          instruction: "Pick it up.",
          decides: "act for `last_worker`: assign it, then wake them (kind `assigned`)",
          decide: () => [],
        },
      ],
      {},
    );

    expect(page).toContain(
      "Note posted with the change: none, since the ticket shows the change. A team can add one with `pipeline.policies.silent.instruction`.",
    );

    expect(page).toContain(
      "Instruction:\n\n```text\nPick it up.\n```\n\nNote posted with the change: none; the instruction is the wake's.",
    );
  });

  it("words every condition shape", () => {
    expect(conditionLines({ any: [{ pr_draft: true }, { actor_is: "assignee" }] })).toEqual([
      "- any of:",
      "  - `pr_draft: true`",
      "  - `actor_is: assignee`",
    ]);
  });

  it("leaves out the instruction a policy does not have", () => {
    const page = renderPolicyReference(
      [
        {
          id: "quiet",
          summary: "Drops it.",
          on: ["pr.closed"],
          decides: "drop: r",
          decide: () => [],
        },
      ],
      {},
    );

    expect(page).not.toContain("Instruction:");
    expect(page).toContain("Decides: drop: r.");
    const undescribed = renderPolicyReference(
      [{ id: "bare", summary: "s", on: ["pr.closed"], instruction: "Hi.", decide: () => [] }],
      {},
    );

    expect(undescribed).toContain("| [`bare`](#bare) | `pr.closed` |  |");
    expect(undescribed).toContain("Note posted with the change:");
  });
});
