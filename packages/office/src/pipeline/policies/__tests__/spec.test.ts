import { describe, expect, it } from "vitest";
import { createPolicyContext, harnessEvent, harnessState } from "@outstaff/policy";
import { acts, personText, wakes } from "#/pipeline/policies/spec.js";
import { OPTS } from "./support.js";

describe("the policy specs", () => {
  it("say in words whom a policy wakes, or what it changes for whom", () => {
    expect(personText(["mentioned", "assignee"])).toBe("`mentioned`, else `assignee`");
    expect(wakes({ person: "actor", kind: "assigned", subject: "next_ready_ticket" }).decides).toBe(
      "wake `actor` (kind `assigned`), with its next ready ticket",
    );

    expect(
      acts({
        as: "actor",
        ops: [
          { move: "review" },
          { assign: "requester" },
          { assign: "self" },
          { set_parent: true },
        ],
        wake: { kind: "assigned" },
      }).decides,
    ).toBe(
      "act for `actor`: move the ticket to `review`, assign it to the requester, assign it to the agent acted for, set its parent, then wake them (kind `assigned`)",
    );
  });

  it("decide with the context's helpers", () => {
    const e = harnessEvent("agent.idle", { actor: { kind: "agent", id: "sam" } });
    const ctx = createPolicyContext(
      { id: "p", summary: "s", on: ["agent.idle"], decide: () => [] },
      { event: e, state: harnessState(), options: OPTS },
      "no condition",
    );

    expect(acts({ as: "actor", ops: [{ move: "done" }] }).decide(e, ctx)).toEqual([
      { type: "drop", reason: "nothing to change: move: the event has no linked ticket" },
    ]);
  });
});
