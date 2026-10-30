import { describe, expect, it } from "vitest";
import { checkProposals, definePolicy, policyProblems } from "#/define.js";
import type { PolicyDefinition } from "#/policy.types.js";

const base: PolicyDefinition = {
  id: "release_freeze",
  summary: "Holds assignments during a freeze.",
  on: ["ticket.assigned"],
  decide: () => [],
};

describe("definePolicy", () => {
  it("returns the policy, frozen", () => {
    const policy = definePolicy({ ...base, instruction: "{{ticket}} waits.", priority: 2 });
    expect(policy).toMatchObject({ id: "release_freeze", priority: 2 });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("throws with every problem, naming the policy when it has an id", () => {
    expect(() => definePolicy({ ...base, id: "Release", on: [], instruction: "{{nope}}" })).toThrow(
      "not a policy Release: id: use lowercase letters, digits and underscores; on: Too small: expected array to have >=1 items; instruction: unknown variable nope",
    );

    expect(() => definePolicy(undefined as unknown as PolicyDefinition)).toThrow(/^not a policy: /);
  });
});

describe("policyProblems", () => {
  it("checks the event types, the decide function and a malformed instruction", () => {
    expect(policyProblems(base)).toEqual([]);
    expect(policyProblems({ ...base, on: ["pr.nope"], decide: "no", instruction: "{{x" })).toEqual([
      expect.stringMatching(/^on\.0: /),
      expect.stringMatching(/^instruction: /),
      "decide: must be a function",
    ]);
  });
});

describe("checkProposals", () => {
  const wake = { type: "wake", person: "sam", kind: "assigned", instruction: "Go.", reason: "r" };

  it("accepts every kind of proposal, an op outside the bookkeeping set included, and keeps the objects", () => {
    const list = [
      wake,
      { ...wake, subject: { type: "ticket", ref: "ACME-1" } },
      {
        type: "act",
        as: "sam",
        ops: [
          { op: "move", ticket: "ACME-1", to: "review" },
          { op: "assign", ticket: "ACME-1", to: null },
          { op: "set_parent", ticket: "ACME-1", parent: "ACME-0" },
          { op: "comment", on: { ticket: "ACME-1" }, body: "x" },
        ],
        note: "n",
        reason: "r",
      },
      { type: "drop", reason: "r" },
      { type: "suppress", person: "sam", kind: "chat", reason: "r" },
    ];

    const checked = checkProposals(list);
    expect(checked).toEqual({ value: list });
    expect((checked as { value: unknown[] }).value[0]).toBe(wake);
  });

  it("says why a result is not a list of proposals", () => {
    expect(checkProposals(undefined)).toEqual({
      skip: "returned something other than a list of proposals",
    });

    expect(checkProposals([wake, { type: "wake", person: "sam" }])).toEqual({
      skip: expect.stringMatching(/^returned a malformed proposal 1: kind: /),
    });

    const badMove = { type: "act", as: "sam", ops: [{ op: "move", ticket: "A" }], reason: "r" };
    expect(checkProposals([badMove])).toEqual({
      skip: expect.stringMatching(/^returned a malformed proposal 0: /),
    });

    expect(checkProposals([{ type: "drop" }])).toEqual({
      skip: expect.stringMatching(/^returned a malformed proposal 0: reason: /),
    });
  });
});
