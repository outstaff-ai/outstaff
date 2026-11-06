import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { describeDecision } from "#/pipeline/describe.js";
import { ADA, SAM, event, judge, moveData, t, traceOf, type World } from "./support.js";

const NOT_BACKLOG = { not: { ticket_status: ["backlog"] } };

/** ACME-1, planned for later: in backlog, assigned to sam, asked for by ada. */
const backlog: World = { tickets: { "ACME-1": t("backlog", "sam", { requester: "ada-admin" }) } };
const ready: World = { tickets: { "ACME-1": t("ready", "sam", { requester: "ada-admin" }) } };

const onTicket = (type: PipelineEvent["type"], o: Partial<PipelineEvent> = {}) =>
  event(type, { subject: { ticket: "ACME-1" }, actor: ADA, ...o });

const started = (kind: string) =>
  onTicket("agent.started", { actor: SAM, data: { workItem: "w-1", kind } });

/** Every decision the built-in policies make of the event, in words. */
const decisions = (e: PipelineEvent, world: World) =>
  traceOf(e, world).decisions.map(describeDecision);

describe("a ticket in backlog stays in backlog", () => {
  it("wakes no one when it is created in backlog with an agent assigned, or assigned to one there", () => {
    for (const type of ["ticket.created", "ticket.assigned"] as const) {
      for (const actor of [ADA, { kind: "agent" as const, id: "mira" }]) {
        const e = onTicket(type, { actor });
        expect(judge("assigned_to_assignee", e, backlog)).toEqual({ failed: NOT_BACKLOG });
        expect(decisions(e, backlog).filter((d) => d.startsWith("wake"))).toEqual([]);
      }
    }
  });

  it("wakes the agent on a human's comment, and the round leaves the status and assignee alone", () => {
    const comment = onTicket("ticket.commented", { data: { body: "Use the EU region." } });
    expect(decisions(comment, backlog)).toEqual(["wake sam (ticket_comment) on ticket ACME-1"]);
    expect(traceOf(comment, backlog).decisions[0]).toMatchObject({
      instruction: expect.stringContaining(
        "ACME-1's status now: backlog. A done or canceled ticket stays closed unless the comment asks to reopen it. A ticket in backlog stays in backlog: answer or update it, and do not start the work.",
      ),
    });

    const mention = onTicket("ticket.commented", { data: { body: "@sam?", mentions: ["sam"] } });
    expect(decisions(mention, backlog)).toEqual(["wake sam (asked) on ticket ACME-1"]);

    for (const kind of ["ticket_comment", "assigned"]) {
      expect(judge("start_marks_active", started(kind), backlog)).toEqual({
        failed: { any: [NOT_BACKLOG, { work_from_chat: true }] },
      });

      expect(decisions(started(kind), backlog)).toEqual(["drop: no policy matched"]);
    }
  });

  it("starts when a human moves it to ready: the idle pull wakes the agent and the round makes it active", () => {
    const moved = onTicket("ticket.moved", { data: { ...moveData("ready"), from: "backlog" } });
    expect(decisions(moved, ready).filter((d) => d.startsWith("wake"))).toEqual([]);

    const idle = event("agent.idle", { actor: SAM });
    const next = { ...ready, ready: { sam: [{ key: "ACME-1", readyAt: "2026-10-05T09:00:00Z" }] } };
    expect(judge("idle_pulls_next", idle, next)).toEqual(["wake sam (assigned) on ticket ACME-1"]);
    expect(judge("start_marks_active", started("assigned"), ready)).toEqual([
      "act for sam: move ACME-1 to active",
    ]);
  });

  it("starts when a human asks for the work in chat: the round from that request makes it active", () => {
    const fromChat = onTicket("agent.started", {
      actor: SAM,
      data: { workItem: "w-2", kind: "assigned", fromChat: true },
    });

    expect(judge("start_marks_active", fromChat, backlog)).toEqual([
      "act for sam: move ACME-1 to active",
    ]);
  });

  it("starts when a human moves it to active", () => {
    const moved = onTicket("ticket.moved", { data: moveData("active") });
    const active: World = { tickets: { "ACME-1": t("active", "sam") } };
    expect(judge("moved_active_to_assignee", moved, active)).toEqual([
      "wake sam (assigned) on ticket ACME-1",
    ]);
  });
});
