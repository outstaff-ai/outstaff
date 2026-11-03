import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_POLICIES,
  evaluatePipeline,
  event,
  judge,
  OPTS,
  pr,
  prRef,
  SAM,
  stateOf,
  t,
  traceOf,
} from "./support.js";

const ID = "notify_human_on_handoff";

const back = (status: string, data: Record<string, unknown> = {}) =>
  event("agent.handed_back", {
    subject: { ticket: "ACME-1" },
    actor: SAM,
    data: {
      status,
      kind: "assigned",
      summary: "Added the greeting.\nNothing else needed.",
      ...data,
    },
  });

const world = (status: StaticTicket["status"], assignee: string | undefined = "sam") => ({
  tickets: { "ACME-1": t(status, assignee, { requester: "ada.admin" }) },
  prs: [pr(9, { url: "https://github.example/acme-example/shop/pull/9" }), pr(10, { draft: true })],
  links: { 9: "ACME-1", 10: "ACME-1" },
});

const notices = (e: Parameters<typeof traceOf>[0], w: Parameters<typeof traceOf>[1]) =>
  traceOf(e, w).decisions.filter((d) => d.policy === ID);

describe("notify_human_on_handoff", () => {
  it("tells the requester of a hand-back as done, with the ticket's pull requests open for review and the summary", () => {
    expect(notices(back("done"), world("active"))).toEqual([
      {
        type: "notify",
        policy: ID,
        as: "sam",
        human: "ada.admin",
        need: "review",
        ticket: "ACME-1",
        prs: [
          {
            ref: "acme-example/shop#9",
            url: "https://github.example/acme-example/shop/pull/9",
            title: "Change 9",
          },
        ],
        text: "Added the greeting.\nNothing else needed.",
      },
    ]);
  });

  it("tells the human the agent handed the ticket over to, and no one for an agent", () => {
    expect(judge(ID, back("done"), world("active", "grace.lead"))).toEqual([
      "notify grace.lead in chat, as sam (review) of ACME-1 with acme-example/shop#9",
    ]);

    expect(judge(ID, back("done"), world("active", "noor"))).toEqual([
      "drop: ACME-1 goes to no human: it has no requester, or it was handed over to an agent",
    ]);
  });

  it("sends nothing more for work from a chat thread, which gets the result", () => {
    expect(judge(ID, back("done", { chat: true }), world("active"))).toEqual([
      "notify ada.admin of nothing more of ACME-1: told in the chat thread the work came from",
    ]);
  });

  it("leaves a blocked hand-back to the PM or the blocked agent, and ignores a waiting one", () => {
    expect(judge(ID, back("done"), world("blocked"))).toMatchObject({ failed: {} });
    expect(judge(ID, back("blocked"), world("active"))).toMatchObject({ failed: {} });
    expect(judge(ID, back("waiting"), world("active"))).toMatchObject({ failed: {} });
    expect(judge(ID, back("blocked"), world("blocked", "ada.admin"))).toEqual([
      "drop: only a hand-back as done gives the ticket to a human: a blocked one goes to the PM, or the blocked agent tells the requester itself (hand_back.blocked_notify)",
    ]);
  });

  it("tells no one of a silent hand-back: nothing landed on anyone", () => {
    const silent = back("silent", {
      before: { status: "review", assignee: { id: "ada.admin", kind: "human" } },
    });

    for (const w of [
      world("active"),
      world("review", "ada.admin"),
      world("blocked", "ada.admin"),
    ]) {
      expect(notices(silent, w).filter((d) => d.type === "notify")).toEqual([]);
    }
  });

  it("tells the human an agent gives a blocked ticket to, as a PM does when it cannot unblock it", () => {
    const given = event("ticket.assigned", {
      subject: { ticket: "ACME-1" },
      actor: { kind: "agent", id: "priya" },
    });

    expect(judge(ID, given, world("blocked", "ada.admin"))).toEqual([
      "notify ada.admin in chat, as priya (blocked) of ACME-1 with acme-example/shop#9",
    ]);

    // The blocked agent's own assignment to the PM, reported after the PM gave the ticket to the human.
    const late = event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: SAM });
    const blockedOnSam = {
      ...world("blocked", "ada.admin"),
      tickets: {
        "ACME-1": t("blocked", "ada.admin", { requester: "ada.admin", blockedAgent: "sam" }),
      },
    };

    expect(judge(ID, late, blockedOnSam)).toEqual([
      "drop: sam is blocked on ACME-1: its hand-back decides who is told",
    ]);

    expect(judge(ID, given, blockedOnSam)).toEqual([
      "notify ada.admin in chat, as priya (blocked) of ACME-1 with acme-example/shop#9",
    ]);

    const echo = { ...given, data: { echo: "e:hand_back_done" } };
    expect(judge(ID, echo, world("review", "ada.admin"))).toEqual([
      "drop: the echo of an office act: the event that caused it tells the human",
    ]);

    expect(judge(ID, given, world("active", "ada.admin"))).toMatchObject({ failed: {} });
    // A tracker event that carries a status of its own is still judged by the ticket.
    const odd = { ...given, data: { status: "done" } };
    expect(judge(ID, odd, world("active", "noor"))).toEqual([
      "drop: ACME-1 is not with a human in review or blocked",
    ]);

    expect(judge(ID, given, world("blocked", "noor"))).toMatchObject({ failed: {} });
  });

  it("tells the requester of the ticket of an agent's pull request opened for review", () => {
    const opened = (number: number) =>
      event("pr.opened", { subject: { pr: prRef(number) }, actor: SAM });

    expect(judge(ID, opened(9), world("active"))).toEqual([
      "notify ada.admin in chat, as sam (review) of ACME-1 with acme-example/shop#9",
    ]);

    expect(judge(ID, opened(10), world("active"))).toMatchObject({ failed: {} });
    expect(judge(ID, opened(11), { prs: [pr(11)] })).toEqual([
      "notify ada.admin in chat, as sam (review) with acme-example/shop#11",
    ]);
  });

  it("finds no one to tell without a requester or fallback human", () => {
    const opened = event("pr.opened", { subject: { pr: prRef(11) }, actor: SAM });
    const { fallbackRequester: _none, ...noFallback } = OPTS;
    const trace = evaluatePipeline(
      opened,
      stateOf({ prs: [pr(11)] }),
      BUILT_IN_POLICIES,
      noFallback,
    );

    expect(trace.decisions.filter((d) => d.policy === ID)).toEqual([
      {
        type: "drop",
        policy: ID,
        reason: "no agent's pull request with a human to review it",
      },
    ]);
  });
});
