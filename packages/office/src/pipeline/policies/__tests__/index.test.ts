import { describe, expect, it } from "vitest";
import { BUILT_IN_POLICIES, POLICY_SWITCH_OF } from "#/pipeline/policies/index.js";
import { event, prRef, prWorld, SAM, t, traceOf } from "./support.js";

describe("the built-in policies", () => {
  it("are listed once each, every one with what it decides and every wake with an instruction", () => {
    const ids = BUILT_IN_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // An act may post no note: the ticket's history shows its changes.
    expect(
      BUILT_IN_POLICIES.filter(
        (p) => !p.decides || (!p.instruction && !p.decides.startsWith("act for")),
      ),
    ).toEqual([]);

    expect(Object.keys(POLICY_SWITCH_OF).every((id) => ids.includes(id))).toBe(true);
  });

  it("post a note in the agent's own voice with an act; an act that then wakes the agent gives the instruction to the wake", () => {
    const acts = BUILT_IN_POLICIES.filter(
      (p) => p.decides!.startsWith("act for") && !p.decides!.includes("then wake"),
    );

    expect(acts.length).toBeGreaterThan(0);
    expect(acts.filter((p) => p.instruction?.includes("{{person}}"))).toEqual([]);
    const trace = traceOf(
      event("pr.opened", { subject: { pr: prRef(9) }, actor: SAM }),
      prWorld({}, "active"),
    );

    expect(trace.decisions.filter((d) => d.type === "act")).toMatchObject([
      {
        type: "act",
        as: "sam",
        note: "Moved to review: pull request #9 by sam is open for review.",
      },
    ]);
  });

  it("post no note with an act that only restates the ticket's history", () => {
    const onTicket = (type: "agent.started" | "agent.handed_back", status: string) =>
      event(type, {
        subject: { ticket: "ACME-1" },
        actor: SAM,
        data: { workItem: "w-1", kind: "assigned", status },
      });

    const world = (status: "ready" | "active", roles: Record<string, string> = {}) => ({
      tickets: { "ACME-1": t(status, "sam", { requester: "ada.admin" }) },
      roles,
    });

    const blocked = onTicket("agent.handed_back", "blocked");
    const cases = [
      ["start_marks_active", onTicket("agent.started", ""), world("ready")],
      ["hand_back_done", onTicket("agent.handed_back", "done"), world("active")],
      ["hand_back_blocked", blocked, world("active")],
      ["hand_back_blocked_to_pm", blocked, world("active", { pm: "priya" })],
    ] as const;

    for (const [id, e, w] of cases) {
      const acts = traceOf(e, w).decisions.filter((d) => d.policy === id && d.type === "act");
      expect(acts.map((a) => [id, "note" in a])).toEqual([[id, false]]);
    }
  });
});
