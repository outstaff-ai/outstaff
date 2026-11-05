import type { StaticTicket } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { describeDecision } from "#/pipeline/describe.js";
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
  prs: [
    pr(9, { url: "https://github.example/acme-example/shop/pull/9", head: "a1" }),
    pr(10, { draft: true }),
  ],
  links: { 9: "ACME-1", 10: "ACME-1" },
});

const notices = (e: Parameters<typeof traceOf>[0], w: Parameters<typeof traceOf>[1]) =>
  traceOf(e, w).decisions.filter((d) => d.policy === ID);

/** Ada with a chat identity: her chat threads with the agent tie tickets. */
const WITH_CHAT = {
  ...OPTS,
  humans: [
    { name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "ada.admin", chat: "U0ADA" } },
  ],
};

const judgeChat = (e: Parameters<typeof traceOf>[0], w: Parameters<typeof traceOf>[1]) =>
  evaluatePipeline(e, stateOf(w), BUILT_IN_POLICIES, WITH_CHAT)
    .decisions.filter((d) => d.policy === ID)
    .map(describeDecision);

/** The ticket as a round found it: in review with Ada, after an earlier hand-back. */
const WITH_ADA = { status: "review", assignee: { id: "ada.admin", kind: "human" } };
const SEEN = { human: "ada.admin", prs: { "acme-example/shop#9": "a1" } };

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
        seen: SEEN,
      },
    ]);
  });

  it("lists every ticket the hand-back gives the requester: its sub-tickets in review and the tickets of its pull requests", () => {
    const split = (owner = "sam") => ({
      ...world("active", owner),
      tickets: {
        "ACME-1": t("active", owner, { requester: "ada.admin" }),
        "ACME-2": t("review", "sam", { parent: "ACME-1" }),
        "ACME-3": t("backlog", "sam", { parent: "ACME-1" }),
        "ACME-4": t("active", "sam"),
      },
      prs: [pr(9), pr(11), pr(12)],
      links: { 9: "ACME-1", 11: "ACME-2", 12: "ACME-4" },
    });

    const handedBack = (data: Record<string, unknown> = {}) =>
      back("done", { created: ["ACME-2", "ACME-3"], opened: ["ACME-4"], ...data });

    expect(judge(ID, handedBack(), split())).toEqual([
      "notify ada.admin in chat, as sam (review) of ACME-1 with acme-example/shop#9",
      "notify ada.admin in chat, as sam (review) of ACME-2 with acme-example/shop#11",
      "notify ada.admin in chat, as sam (review) of ACME-4 with acme-example/shop#12",
    ]);

    expect(judgeChat(handedBack({ chat: ["U0ADA"] }), split())).toEqual([
      "notify ada.admin of nothing more of ACME-1: told in the chat thread the work came from",
      "notify ada.admin of nothing more of ACME-2: told in the chat thread the work came from",
      "notify ada.admin of nothing more of ACME-4: told in the chat thread the work came from",
    ]);

    // Handed over to another human: the item's ticket goes to them, its other tickets to the requester. With no
    // requester known, those stay as they are, and no one is told of them.
    const { fallbackRequester: _none, ...noFallback } = OPTS;
    const w = split("grace.lead");
    w.tickets["ACME-1"] = t("active", "grace.lead");
    const trace = evaluatePipeline(handedBack(), stateOf(w), BUILT_IN_POLICIES, noFallback);
    expect(trace.decisions.filter((d) => d.policy === ID)).toMatchObject([
      { type: "notify", human: "grace.lead", ticket: "ACME-1" },
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

  it("sends nothing more for a round that posts its own result in a chat thread with the human", () => {
    expect(judgeChat(back("done", { chat: ["U0ADA"] }), world("active"))).toEqual([
      "notify ada.admin of nothing more of ACME-1: told in the chat thread the work came from",
    ]);

    // The thread was with someone else, or the human has no chat identity: they are told.
    const news = ["notify ada.admin in chat, as sam (review) of ACME-1 with acme-example/shop#9"];
    expect(judgeChat(back("done", { chat: ["U0GRACE"] }), world("active"))).toEqual(news);
    expect(judge(ID, back("done", { chat: ["U0ADA"] }), world("active"))).toEqual(news);
  });

  it("tells of a later round on work from chat only what is new: a new head, not the same one", () => {
    // A rebase round on a ticket filed from chat: its round reports to no thread of its own, so the notice is made, and
    // the office posts it in the ticket's chat thread (see the notice desk).
    const rebase = back("done", { kind: "rebase", before: WITH_ADA, notified: SEEN });
    const pushed = { ...world("review", "ada.admin"), prs: [pr(9, { head: "b2" })] };
    expect(notices(rebase, pushed)).toMatchObject([
      {
        type: "notify",
        human: "ada.admin",
        ticket: "ACME-1",
        seen: { human: "ada.admin", prs: { "acme-example/shop#9": "b2" } },
      },
    ]);

    expect(judgeChat(rebase, world("review", "ada.admin"))).toEqual([
      "drop: nothing new for ada.admin: ACME-1 was in review with ada.admin already, with the pull request heads they were told of",
    ]);
  });

  it("tells nothing of a round that left nothing new for the human, decided from the state", () => {
    const round = (kind: string, data: Record<string, unknown> = {}) =>
      back("done", { kind, before: WITH_ADA, notified: SEEN, ...data });

    // A merge round on a pull request that is already merged: nothing is open for review, whatever was told before.
    const merged = {
      ...world("review", "ada.admin"),
      prs: [pr(9, { state: "merged", head: "a1" })],
    };

    const none =
      "drop: nothing new for ada.admin: ACME-1 was in review with ada.admin already, and no pull request of it is open for review";

    expect(judge(ID, round("merge"), merged)).toEqual([none]);
    expect(judge(ID, round("merge", { notified: undefined }), merged)).toEqual([none]);

    // A rebase round that pushed nothing: the head the human was told of.
    expect(judge(ID, round("rebase"), world("review", "ada.admin"))).toEqual([
      "drop: nothing new for ada.admin: ACME-1 was in review with ada.admin already, with the pull request heads they were told of",
    ]);

    // A rebase that pushed a new head, a last notice to someone else, or none remembered: the pull request is news.
    const news = ["notify ada.admin in chat, as sam (review) of ACME-1 with acme-example/shop#9"];
    const pushed = { ...world("review", "ada.admin"), prs: [pr(9, { head: "b2" })] };
    expect(judge(ID, round("rebase"), pushed)).toEqual(news);
    const toGrace = round("rebase", { notified: { ...SEEN, human: "grace.lead" } });
    expect(judge(ID, toGrace, world("review", "ada.admin"))).toEqual(news);
    const unknown = round("rebase", { notified: undefined });
    expect(judge(ID, unknown, world("review", "ada.admin"))).toEqual(news);

    // A round the human's feedback started had the ticket back with the agent: handing it back is news.
    const feedback = round("review_feedback", {
      before: { status: "active", assignee: { id: "sam", kind: "agent" } },
    });

    expect(judge(ID, feedback, world("active"))).toEqual(news);
  });

  it("tells the human once of a pull request newly opened for review, and remembers its head", () => {
    const opened = back("done", {
      before: { status: "ready", assignee: { id: "sam", kind: "agent" } },
    });

    expect(notices(opened, world("active"))).toMatchObject([
      { type: "notify", human: "ada.admin", ticket: "ACME-1", seen: SEEN },
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
