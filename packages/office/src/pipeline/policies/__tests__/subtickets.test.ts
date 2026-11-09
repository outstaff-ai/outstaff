import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_POLICIES,
  event,
  evaluatePipeline,
  judge,
  OPTS,
  pr,
  SAM,
  stateOf,
  t,
  traceOf,
  type World,
} from "./support.js";
import { runPolicy } from "@outstaff/policy";
import { describeDecision } from "#/pipeline/describe.js";
import { policy as closedToAgent } from "#/pipeline/policies/subticket_closed_to_agent.js";

const { fallbackRequester: _none, ...noFallback } = OPTS;

/** One policy's decisions on a team with no human to fall back to. */
const withoutFallback = (id: string, e: Parameters<typeof judge>[1], w: World) =>
  evaluatePipeline(e, stateOf(w), BUILT_IN_POLICIES, noFallback)
    .decisions.filter((d) => d.policy === id)
    .map(describeDecision);

/** ACME-49 closed by sam, a sub-ticket of ACME-48. */
const closed = (status: "done" | "canceled" = "done") =>
  event("ticket.closed", {
    subject: { ticket: "ACME-49" },
    actor: { kind: "automation", id: "workstate" },
    data: { status, closedBy: { kind: "agent", id: "sam" } },
  });

const sub = (status: StaticTicket["status"], assignee = "sam") =>
  t(status, assignee, { parent: "ACME-48" });

const world = (parent: StaticTicket["status"], more: Record<string, StaticTicket> = {}): World => ({
  tickets: {
    "ACME-48": t(parent, "sam", { requester: "ada.admin" }),
    "ACME-49": sub("done"),
    ...more,
  },
});

describe("a sub-ticket closing", () => {
  it("wakes its agent on the parent, listing the parent's open sub-tickets", () => {
    const w = world("active", { "ACME-50": sub("ready"), "ACME-51": sub("ready", "noor") });
    expect(judge("subticket_closed_to_agent", closed(), w)).toEqual([
      "wake sam (assigned) on ticket ACME-48",
    ]);

    const wake = traceOf(closed(), w).decisions.find(
      (d) => d.policy === "subticket_closed_to_agent",
    );

    expect(wake).toMatchObject({
      instruction:
        "ACME-49 was closed as done. The open sub-tickets of ACME-48: ACME-50, ACME-51. Continue with the next one in the order you planned, the way the repository asks. When none is for you to do now and each waits on a human's review or on work someone else has under way, you are waiting, not blocked: hand back silent, with no new message. When one waits on an answer or a decision (it is blocked, or nobody answered a question on it yet), hand back blocked, naming who and what.",
    });

    expect(judge("subtickets_closed_move_parent", closed(), w)).toEqual([
      "drop: ACME-48 still has open sub-tickets: ACME-50, ACME-51",
    ]);
  });

  it("wakes no one when the rest is someone else's, and nothing for a ticket without an open parent", () => {
    const theirs = world("active", { "ACME-50": sub("ready", "noor") });
    expect(judge("subticket_closed_to_agent", closed(), theirs)).toEqual([
      "drop: no agent has another unfinished sub-ticket of ACME-48",
    ]);

    // A sibling the closed ticket blocked may still be in the backlog: it counts.
    const waiting = world("active", { "ACME-50": sub("backlog") });
    expect(judge("subticket_closed_to_agent", closed(), waiting)).toEqual([
      "wake sam (assigned) on ticket ACME-48",
    ]);

    // The closed sub-ticket was someone else's: the parent's agent, whose sibling it is, is woken.
    const other = world("active", {
      "ACME-49": t("done", "noor", { parent: "ACME-48" }),
      "ACME-50": sub("ready"),
    });

    expect(judge("subticket_closed_to_agent", closed(), other)).toEqual([
      "wake sam (assigned) on ticket ACME-48",
    ]);

    expect(judge("subticket_closed_to_agent", closed(), world("done"))).toMatchObject({
      failed: { parent_status: expect.any(Array) },
    });

    const orphan = { tickets: { "ACME-49": t("done", "sam") } };
    expect(judge("subticket_closed_to_agent", closed(), orphan)).toMatchObject({ failed: {} });
    const nobody = world("active", { "ACME-49": t("done", undefined, { parent: "ACME-48" }) });
    nobody.tickets!["ACME-48"] = t("active", "ada.admin");
    expect(judge("subticket_closed_to_agent", closed(), nobody)).toEqual([
      "drop: no agent has another unfinished sub-ticket of ACME-48",
    ]);
  });

  it("counts a sibling whose status is not known as finished, and drops when its instruction cannot be rendered", () => {
    const unknown = world("active", { "ACME-50": { parent: "ACME-48" } as StaticTicket });
    expect(judge("subticket_closed_to_agent", closed(), unknown)).toEqual([
      "drop: no agent has another unfinished sub-ticket of ACME-48",
    ]);

    const input = {
      event: closed(),
      state: stateOf(world("active", { "ACME-50": sub("ready") })),
      options: OPTS,
    };

    expect(runPolicy({ ...closedToAgent, instruction: "{{unknown}}" }, input).proposals).toEqual([
      { type: "drop", reason: expect.stringMatching(/^the instruction cannot be rendered: /) },
    ]);
  });

  it("moves an active parent on when its last sub-ticket closes: to review with the requester", () => {
    expect(judge("subtickets_closed_move_parent", closed("canceled"), world("active"))).toEqual([
      "act for sam: move ACME-48 to review, assign ACME-48 to human ada.admin",
    ]);

    expect(judge("subtickets_closed_move_parent", closed(), world("review"))).toMatchObject({
      failed: { parent_status: ["active"] },
    });
  });

  it("only moves the parent to review when no human is known to give it to", () => {
    const w = world("active");
    w.tickets!["ACME-48"] = t("active", "sam");
    expect(withoutFallback("subtickets_closed_move_parent", closed(), w)).toEqual([
      "act for sam: move ACME-48 to review",
    ]);
  });

  it("to done with its agent when the parent's own pull requests merged", () => {
    const w: World = {
      ...world("active"),
      prs: [pr(9, { state: "merged" })],
      links: { 9: "ACME-48" },
    };

    expect(judge("subtickets_closed_move_parent", closed(), w)).toEqual([
      "act for sam: move ACME-48 to done",
    ]);
  });

  it("acts for the closed sub-ticket's agent when no agent holds the parent", () => {
    const w = world("active");
    w.tickets!["ACME-48"] = t("active", undefined, {});
    expect(judge("subtickets_closed_move_parent", closed(), w)).toMatchObject([
      expect.stringMatching(/^act for sam: move ACME-48 to review/),
    ]);

    w.tickets!["ACME-49"] = t("done", undefined, { parent: "ACME-48" });
    expect(judge("subtickets_closed_move_parent", closed(), w)).toEqual([
      "drop: no agent to act for on ACME-48",
    ]);
  });
});

describe("a done hand-back on a parent with open sub-tickets", () => {
  const back = (kind = "assigned") =>
    event("agent.handed_back", {
      subject: { ticket: "ACME-48" },
      actor: SAM,
      data: { status: "done", kind, created: ["ACME-49", "ACME-50"] },
    });

  it("keeps the parent active with the agent and hands in only the sub-tickets in review", () => {
    const w = world("active", { "ACME-49": sub("review"), "ACME-50": sub("ready") });
    expect(judge("hand_back_done", back(), w)).toEqual([
      "drop: ACME-48 has open sub-tickets (ACME-49, ACME-50): it stays active with sam until the last one closes",
      "act for sam: assign ACME-49 to human ada.admin",
    ]);

    w.tickets!["ACME-48"] = t("ready", "ada.admin", { requester: "ada.admin" });
    expect(judge("hand_back_done", back(), w)).toEqual([
      "act for sam: move ACME-48 to active, assign ACME-48 to agent sam, assign ACME-49 to human ada.admin",
    ]);
  });

  it("sends the parent to review with the requester when every sub-ticket is in review or closed", () => {
    const w = world("active", { "ACME-49": sub("review"), "ACME-50": sub("done") });
    expect(judge("hand_back_done", back(), w)).toEqual([
      "act for sam: move ACME-48 to review, assign ACME-48 to human ada.admin, assign ACME-49 to human ada.admin",
    ]);
  });

  it("moves the parent on as usual when its only other sub-tickets wait in the backlog for later", () => {
    const w = world("active", { "ACME-49": sub("done"), "ACME-50": sub("backlog", "") });
    expect(judge("hand_back_done", back(), w)).toEqual([
      "act for sam: move ACME-48 to review, assign ACME-48 to human ada.admin",
    ]);
  });

  it("hands in nothing when no human is known to give the sub-tickets to", () => {
    const w = world("active", { "ACME-49": sub("review"), "ACME-50": sub("ready") });
    w.tickets!["ACME-48"] = t("active", "sam");
    expect(withoutFallback("hand_back_done", back(), w)).toEqual([
      "drop: ACME-48 has open sub-tickets (ACME-49, ACME-50): it stays active with sam until the last one closes",
    ]);
  });

  it("leaves the ticket as it is after a merge round: nothing in it is left for the human", () => {
    expect(judge("hand_back_done", back("merge"), world("review"))).toMatchObject({
      failed: { not: { work_kind: ["merge"] } },
    });
  });
});
