import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { event, judge, t, traceOf, type World } from "./support.js";

const WORKSTATE = { kind: "automation" as const, id: "workstate" };
const WHY = "deploy passes on main at abc1234, which includes #77's merge";

/** The work state found that something ACME-3 may wait on happened. */
const maybe = (data: Record<string, unknown> = {}): PipelineEvent =>
  event("ticket.block_maybe_resolved", {
    subject: { ticket: "ACME-3" },
    actor: WORKSTATE,
    data: { cause: "check", ref: "deploy", why: WHY, ...data },
  });

const world = (
  status: StaticTicket["status"],
  roles: Record<string, string> = { pm: "priya" },
): World => ({
  tickets: { "ACME-3": t(status, "ada-admin", { blockedAgent: "sam" }) },
  roles,
});

describe("blocked_maybe_resolved_to_pm", () => {
  it("wakes the PM on a blocked ticket whose named check now passes, saying what happened", () => {
    expect(judge("blocked_maybe_resolved_to_pm", maybe(), world("blocked"))).toEqual([
      "wake priya (unblock) on ticket ACME-3",
    ]);

    const [wake] = traceOf(maybe(), world("blocked")).decisions;
    expect(wake).toMatchObject({ type: "wake", person: "priya", kind: "unblock" });
    expect((wake as { instruction: string }).instruction).toContain(
      `something it may wait on happened: ${WHY}. Check whether the block still holds.`,
    );
  });

  it("leaves a ticket that is no longer blocked alone", () => {
    expect(judge("blocked_maybe_resolved_to_pm", maybe(), world("active"))).toEqual({
      failed: { ticket_status: ["blocked"] },
    });
  });

  it("drops it on a team without a PM", () => {
    expect(judge("blocked_maybe_resolved_to_pm", maybe(), world("blocked", {}))).toEqual([
      "drop: no PM to look at the block (no agent plays role:pm)",
    ]);
  });

  it("is not woken by an unrelated event on a blocked ticket", () => {
    const other = event("ticket.commented", {
      subject: { ticket: "ACME-3" },
      actor: { kind: "human", id: "ada-admin" },
      data: { body: "Nothing new here." },
    });

    const wakes = traceOf(other, world("blocked")).decisions.filter(
      (d) => d.type === "wake" && "person" in d && d.person === "priya",
    );

    expect(wakes).toEqual([]);
  });
});
