import type { StaticTicket } from "@outstaff/core";
import type { WaitingAgent } from "@outstaff/policy";
import { runPolicy } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { policy } from "#/pipeline/policies/ticket_comment_to_waiting_agent.js";
import type { Wake } from "#/pipeline/decisions.types.js";
import { ADA, OPTS, SAM, event, judge, stateOf, t, traceOf, type World } from "./support.js";

const ID = "ticket_comment_to_waiting_agent";

/** Kofi, the PM, mentioned the human on the design ticket ACME-2 at 08:00. */
const ASKED: WaitingAgent = {
  agent: "kofi",
  at: "2026-10-05T08:00:00.000Z",
  url: "https://tracker.acme.example/ACME-2#comment-7",
};

const comment = (data: Record<string, unknown> = {}, actor = ADA) =>
  event("ticket.commented", {
    subject: { ticket: "ACME-2" },
    actor,
    data: { body: "All good, build with this version.", ...data },
  });

/** The design ticket in `status`, sam's, with kofi waiting on the human there unless told otherwise. */
const design = (
  status: StaticTicket["status"],
  waiting: WaitingAgent[] = [ASKED],
  extra: Partial<StaticTicket> = {},
): World => ({
  tickets: {
    "ACME-1": t("blocked", "ada.admin", { lastWorker: "kofi", blockedAgent: "kofi" }),
    "ACME-2": t(status, "sam", { lastWorker: "sam", parent: "ACME-1", ...extra }),
  },
  waiting: { "ACME-2": { "ada-admin": waiting } },
});

/** Why the policy proposed each of its proposals. */
const reasons = (trace: ReturnType<typeof traceOf>) =>
  (trace.policies.find((p) => p.policy === ID)?.proposals ?? []).map((p) =>
    "reason" in p ? p.reason : "",
  );

describe("ticket_comment_to_waiting_agent", () => {
  it("wakes the agent that mentioned the human on the ticket, open or closed, while it is blocked on another", () => {
    for (const status of ["active", "review", "done", "canceled"] as const) {
      expect(judge(ID, comment(), design(status))).toEqual([
        "wake kofi (ticket_comment) on ticket ACME-2",
      ]);
    }

    const trace = traceOf(comment(), design("done"));
    expect(trace.decisions).toEqual([
      expect.objectContaining({
        type: "wake",
        policy: ID,
        person: "kofi",
        kind: "ticket_comment",
        subject: { type: "ticket", ref: "ACME-2" },
        feedback: [
          {
            kind: "ticket_comment",
            actor: "ada-admin",
            body: "All good, build with this version.",
          },
        ],
        instruction: expect.stringContaining(
          "ada-admin commented on ACME-2, where you asked them something: this is their answer to you. Act on it: continue the work you held for it, on whichever ticket that is",
        ),
      }),
    ]);

    const wake = trace.decisions[0] as Wake;
    expect(wake.instruction).toContain("It is a trusted human's word, so it starts new work");
    expect(wake.instruction).toContain("ACME-2's status now: done.");
    expect(reasons(trace)).toEqual([
      "kofi waits on ada-admin on ACME-2: it mentioned them there at 2026-10-05T08:00:00.000Z (https://tracker.acme.example/ACME-2#comment-7), after their last comment there",
    ]);
  });

  it("wakes every agent waiting on the human there, and the trace names each one's comment", () => {
    const mira: WaitingAgent = { agent: "mira", at: "2026-10-05T08:30:00.000Z" };
    const trace = traceOf(comment(), design("done", [ASKED, mira]));
    expect(trace.decisions.map((d) => (d as Wake).person)).toEqual(["kofi", "mira"]);
    expect(reasons(trace)).toEqual([
      expect.stringContaining("kofi waits on ada-admin on ACME-2: it mentioned them there at"),
      "mira waits on ada-admin on ACME-2: it mentioned them there at 2026-10-05T08:30:00.000Z, after their last comment there",
    ]);
  });

  it("wakes no agent that is not waiting on the human there", () => {
    expect(judge(ID, comment(), design("done", []))).toEqual({
      failed: { awaited_human: true },
    });

    const none = traceOf(comment(), design("done", []));
    expect(none.decisions).toEqual([{ type: "drop", reason: "no policy matched" }]);
    expect(none.policies.find((p) => p.policy === ID)?.reason).toBe(
      "no agent waits on ada-admin on ACME-2",
    );

    expect(judge(ID, comment(), { tickets: design("done").tickets ?? {} })).toEqual({
      failed: { awaited_human: true },
    });
  });

  it("is a human's answer: an agent's comment wakes no one waiting on it", () => {
    expect(judge(ID, comment({}, SAM), design("review"))).toEqual({
      failed: { actor_kind: "human" },
    });
  });

  it("gives an agent another policy wakes for the same comment one run", () => {
    // Kofi is also the last worker on the ticket handed back to the human: both wakes become one.
    const handedBack = design("review", [ASKED], {
      lastWorker: "kofi",
      assignee: { id: "ada.admin", kind: "human" },
    });

    const trace = traceOf(comment(), handedBack);
    expect(trace.decisions.map((d) => [d.policy, d.type])).toEqual([
      ["ticket_comment_to_last_worker", "wake"],
    ]);

    expect((trace.decisions[0] as Wake).instruction).toContain("this is their answer to you");
    expect(trace.policies.find((p) => p.policy === ID)?.proposals).toHaveLength(1);

    // The human also mentions kofi: the mention's wake of another kind is suppressed, so kofi has one run.
    const mentioned = traceOf(comment({ mentions: ["kofi", "mira"] }), design("done"));
    expect(mentioned.decisions.map((d) => [d.policy, d.type, (d as Wake).person])).toEqual([
      ["ticket_comment_to_mentioned_agent", "drop", undefined],
      [ID, "wake", "kofi"],
    ]);

    expect(mentioned.aggregation).toContainEqual(
      expect.objectContaining({
        policy: "ticket_comment_to_mentioned_agent",
        outcome: "suppressed",
        reason:
          "suppressed by ticket_comment_to_waiting_agent: the comment answers what kofi asked ada-admin on ACME-2: it is woken for the answer",
      }),
    );

    // A mention of another agent is that agent's wake as usual.
    const other = traceOf(comment({ mentions: ["mira"] }), design("done"));
    expect(other.decisions.map((d) => [d.policy, (d as Wake).person, (d as Wake).kind])).toEqual([
      ["ticket_comment_to_mentioned_agent", "mira", "asked"],
      [ID, "kofi", "ticket_comment"],
    ]);
  });

  it("drops the wake when the team's instruction cannot be rendered, and wakes with none when it has none", () => {
    const run = (instruction: string | undefined) =>
      runPolicy(
        { ...policy, instruction },
        { event: comment(), state: stateOf(design("done")), options: OPTS },
      ).proposals;

    expect(run("{{nope}}")).toEqual([
      { type: "drop", reason: expect.stringContaining("the instruction cannot be rendered: ") },
    ]);

    expect(run(undefined)).toEqual([
      expect.objectContaining({ type: "wake", person: "kofi", instruction: "" }),
    ]);
  });
});
