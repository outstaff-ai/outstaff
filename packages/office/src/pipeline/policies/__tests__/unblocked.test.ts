import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, SAM, event, judge, t, traceOf, type World } from "./support.js";

const WORKSTATE = { kind: "automation" as const, id: "workstate" };
const MIRA = { kind: "agent" as const, id: "mira" };

/** ACME-3 was blocked by ACME-2, which was just closed. */
const unblocked = (closedBy?: PipelineEvent["actor"], data: Record<string, unknown> = {}) =>
  event("ticket.unblocked", {
    subject: { ticket: "ACME-3" },
    actor: WORKSTATE,
    data: { blocker: "ACME-2", ...(closedBy ? { closedBy } : {}), ...data },
  });

const world = (
  status: StaticTicket["status"],
  assignee?: string,
  extra: Partial<StaticTicket> = {},
): World => ({ tickets: { "ACME-3": t(status, assignee, extra) } });

/** Every decision, of every policy, in words. */
const decisions = (e: PipelineEvent, w: World) =>
  traceOf(e, w).decisions.map((d) =>
    d.type === "drop"
      ? `drop: ${d.reason}`
      : `${d.policy}: ${d.type} ${"as" in d ? d.as : "person" in d ? d.person : d.ticket}`,
  );

describe("unblocked_to_ready", () => {
  it("moves a ticket with an agent to ready, as that agent, and wakes it naming the blocker", () => {
    expect(judge("unblocked_to_ready", unblocked(ADA), world("blocked", "sam"))).toEqual([
      "act for sam: move ACME-3 to ready",
      "wake sam (assigned) on ticket ACME-3",
    ]);

    const trace = traceOf(unblocked(ADA), world("blocked", "sam"));
    expect(trace.decisions).toMatchObject([
      { type: "act", policy: "unblocked_to_ready", as: "sam" },
      {
        type: "wake",
        policy: "unblocked_to_ready",
        kind: "assigned",
        instruction:
          "ACME-2, which blocked ACME-3, is closed, and no other ticket blocks it: ACME-3 is ready again. Work on it the way the repository asks.",
      },
    ]);

    expect(trace.decisions[0]).not.toHaveProperty("note");
  });

  it("wakes the agent even when that agent closed the blocker itself", () => {
    expect(decisions(unblocked(SAM), world("blocked", "sam"))).toEqual([
      "unblocked_to_ready: act sam",
      "unblocked_to_ready: wake sam",
    ]);
  });

  it("only moves a sub-ticket whose sibling blocked it while the parent is with the same agent: the parent wake wins", () => {
    const sibling = (parentAgent?: string) =>
      unblocked(SAM, { parent: "ACME-1", ...(parentAgent ? { parentAgent } : {}) });

    expect(decisions(sibling("sam"), world("blocked", "sam"))).toEqual([
      "unblocked_to_ready: act sam",
    ]);

    expect(traceOf(sibling("sam"), world("blocked", "sam")).decisions[0]).not.toHaveProperty(
      "note",
    );

    // The parent is with a human, or with another agent: no parent wake for this agent, so this one wakes it.
    for (const w of [sibling(), sibling("mira")]) {
      expect(decisions(w, world("blocked", "sam"))).toEqual([
        "unblocked_to_ready: act sam",
        "unblocked_to_ready: wake sam",
      ]);
    }
  });

  it("acts as the agent who closed the blocker when no agent holds the ticket, and wakes no one", () => {
    for (const w of [world("blocked", "ada.admin"), world("blocked")]) {
      expect(judge("unblocked_to_ready", unblocked(MIRA), w)).toEqual([
        "act for mira: move ACME-3 to ready",
      ]);

      expect(traceOf(unblocked(MIRA), w).decisions[0]).not.toHaveProperty("note");
    }
  });

  it("drops it, saying why, with no agent to act as: never as the office", () => {
    for (const closer of [ADA, undefined]) {
      const [drop] = traceOf(unblocked(closer), world("blocked", "ada.admin")).decisions;
      expect(drop).toMatchObject({ type: "drop" });
      expect(drop?.type === "drop" && drop.reason).toContain("ticket is not assigned to an agent");
    }

    const [byHuman] = traceOf(unblocked(ADA), world("blocked")).decisions;
    expect(byHuman?.type === "drop" && byHuman.reason).toContain(
      "the ticket was closed by a human, not an agent",
    );

    const [byNobody] = traceOf(unblocked(), world("blocked")).decisions;
    expect(byNobody?.type === "drop" && byNobody.reason).toContain(
      "the event names no one who closed the ticket",
    );
  });

  it("leaves a ticket no longer blocked, or one an agent is blocked on, alone", () => {
    expect(judge("unblocked_to_ready", unblocked(ADA), world("ready", "sam"))).toEqual({
      failed: { ticket_status: ["blocked"] },
    });

    expect(
      judge(
        "unblocked_to_ready",
        unblocked(ADA),
        world("blocked", "ada.admin", { blockedAgent: "sam" }),
      ),
    ).toEqual({ failed: { not: { blocked_agent: true } } });
  });

  it("drops a close by an untrusted human", () => {
    const trace = traceOf(unblocked(MIRA, { untrusted: true }), world("blocked", "sam"));
    expect(trace.decisions).toMatchObject([{ type: "drop" }]);
  });
});

describe("unblocked_to_blocked_agent", () => {
  const onAgent = world("blocked", "ada.admin", { blockedAgent: "sam", lastWorker: "sam" });

  it("wakes the agent blocked on the ticket to check it, and leaves the ticket where it is", () => {
    expect(decisions(unblocked(ADA), onAgent)).toEqual(["unblocked_to_blocked_agent: wake sam"]);
    expect(traceOf(unblocked(ADA), onAgent).decisions).toMatchObject([
      {
        type: "wake",
        kind: "unblocked",
        instruction:
          "ACME-2, which blocked ACME-3, is closed, and no other ticket blocks it. You handed ACME-3 back as blocked: check whether you can continue now. If so, assign it to yourself, move it to active and continue. Otherwise answer on the ticket what is still missing.",
      },
    ]);
  });

  it("wakes the blocked agent even when it closed the blocker", () => {
    expect(decisions(unblocked(SAM), onAgent)).toEqual(["unblocked_to_blocked_agent: wake sam"]);
  });

  it("is for a ticket an agent is blocked on only", () => {
    expect(judge("unblocked_to_blocked_agent", unblocked(ADA), world("blocked", "sam"))).toEqual({
      failed: { blocked_agent: true },
    });
  });
});
