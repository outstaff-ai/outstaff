import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICIES, POLICY_SWITCH_OF } from "#/pipeline/defaults.js";
import { renderPolicyReference } from "#/pipeline/reference.js";
import { conditionLines, decisionText } from "#/pipeline/reference-parts.js";

describe("the pipeline policies reference", () => {
  it("matches the committed page (run `pnpm --filter @outstaff/office run docs:pipeline`)", () => {
    const committed = readFileSync(
      new URL(
        "../../../../../docs/src/content/docs/reference/pipeline-policies.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(committed).toBe(renderPolicyReference(DEFAULT_POLICIES, POLICY_SWITCH_OF));
  });

  it("lists every default policy with its switch and instruction", () => {
    const page = renderPolicyReference(DEFAULT_POLICIES, POLICY_SWITCH_OF);
    for (const p of DEFAULT_POLICIES) {
      expect(page).toContain(`### ${p.id}`);
      expect(page).toContain(p.summary);
    }

    expect(page).toContain("On only while `policies.pull_ready` is on.");
    expect(page).toContain("When: always.");
    expect(page).toContain("Note posted with the change:");
  });

  it("words every decision and condition shape", () => {
    expect(decisionText({ drop: { reason: "nobody to wake" } })).toBe("drop: nobody to wake");
    expect(
      decisionText({
        act: {
          as: ["actor", "author"],
          ops: [{ assign: "self" }, { comment: "x" }, { set_parent: true }],
        },
      }),
    ).toBe(
      "act for `actor`, else `author`: assign it to the agent acted for, comment, set its parent",
    );

    expect(
      decisionText({
        act: { as: "last_worker", ops: [{ assign: "self" }], wake: { kind: "assigned" } },
      }),
    ).toBe(
      "act for `last_worker`: assign it to the agent acted for, then wake them (kind `assigned`)",
    );

    expect(conditionLines({ any: [{ pr_draft: true }, { actor_is: "assignee" }] })).toEqual([
      "- any of:",
      "  - `pr_draft: true`",
      "  - `actor_is: assignee`",
    ]);
  });

  it("leaves out the instruction a policy does not have", () => {
    const page = renderPolicyReference(
      [{ id: "quiet", summary: "Drops it.", on: ["pr.closed"], decide: { drop: { reason: "r" } } }],
      {},
    );

    expect(page).not.toContain("Instruction:");
    expect(page).toContain("Decides: drop: r.");
  });
});
