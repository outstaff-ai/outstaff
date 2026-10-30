import { describe, expect, it } from "vitest";
import { BUILT_IN_POLICIES, POLICY_SWITCH_OF } from "#/pipeline/policies/index.js";
import { event, prRef, prWorld, SAM, traceOf } from "./support.js";

describe("the built-in policies", () => {
  it("are listed once each, every one with an instruction and what it decides", () => {
    const ids = BUILT_IN_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILT_IN_POLICIES.filter((p) => !p.instruction || !p.decides)).toEqual([]);
    expect(Object.keys(POLICY_SWITCH_OF).every((id) => ids.includes(id))).toBe(true);
  });

  it("post a note in the agent's own voice with an act; an act that then wakes the agent gives the instruction to the wake", () => {
    const acts = BUILT_IN_POLICIES.filter(
      (p) => p.decides!.startsWith("act for") && !p.decides!.includes("then wake"),
    );

    expect(acts.length).toBeGreaterThan(0);
    expect(acts.filter((p) => p.instruction!.includes("{{person}}"))).toEqual([]);
    const trace = traceOf(
      event("pr.opened", { subject: { pr: prRef(9) }, actor: SAM }),
      prWorld({}, "active"),
    );

    expect(trace.decisions).toMatchObject([
      {
        type: "act",
        as: "sam",
        note: "Moved to review: pull request #9 by sam is open for review.",
      },
    ]);
  });
});
