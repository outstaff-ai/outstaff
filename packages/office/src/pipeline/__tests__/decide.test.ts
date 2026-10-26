import { createEvaluationContext } from "@outstaff/core";
import { describe, expect, it } from "vitest";
import { decide } from "../decide.js";
import type { PipelineEvent } from "../events.types.js";
import type { DecideSpec, Policy } from "../policy.types.js";
import type { PipelineOptions } from "../state.types.js";
import { event, OPTS, pr, prRef, stateOf, type World } from "./support.js";

const policy = (spec: DecideSpec, instruction?: string): Policy => ({
  id: "p",
  summary: "test",
  on: [],
  decide: spec,
  ...(instruction === undefined ? {} : { instruction }),
});

const run = (p: Policy, e: PipelineEvent, world: World = {}, opts: PipelineOptions = OPTS) => {
  const state = stateOf(world);
  return decide(p, { event: e, ctx: createEvaluationContext(e, state, opts), state, opts });
};

const onTicket = (status: "active" | "review" = "active", assignee = "sam") => ({
  tickets: {
    "ACME-1": {
      status,
      assignee: {
        id: assignee,
        kind: assignee === "sam" ? ("agent" as const) : ("human" as const),
      },
      requester: "grace",
    },
  },
});

describe("decide: wake", () => {
  const review = policy(
    { wake: { person: "author", kind: "review_feedback" } },
    "Look at #{{pr.number}}.",
  );

  it("wakes the person with the rendered instruction, the event's feedback and its subject", () => {
    const e = event("pr.comment", {
      subject: { pr: prRef(9) },
      data: { kind: "comment", body: "Rename it." },
    });

    expect(run(review, e, { prs: [pr(9)] })).toEqual({
      type: "wake",
      policy: "p",
      person: "sam",
      kind: "review_feedback",
      instruction: "Look at #9.",
      feedback: [{ actor: "ada-admin", kind: "comment", body: "Rename it." }],
      subject: { type: "pr", ref: "acme-example/shop#9" },
    });
  });

  it("drops when nobody resolves or the instruction cannot be rendered", () => {
    const e = event("pr.comment", { subject: { pr: prRef(9) } });
    expect(run(review, e)).toEqual({
      type: "drop",
      policy: "p",
      reason: "no one to wake: pull request has no agent author",
    });

    const broken = policy({ wake: { person: "author", kind: "k" } }, "{{nope}}");
    expect(run(broken, e, { prs: [pr(9)] })).toEqual({
      type: "drop",
      policy: "p",
      reason: 'the instruction cannot be rendered: Unknown template variable "nope".',
    });
  });

  it("uses the ticket, document or chat thread as the subject, and an empty instruction when there is none", () => {
    const addressed = policy({ wake: { person: "addressed", kind: "chat" } });
    const chat = (thread?: string) =>
      event("chat.message", {
        subject: { chat: { channel: "D0SAM", ...(thread ? { thread } : {}) } },
        data: { addressed: "sam", body: "hi" },
      });

    expect(run(addressed, chat("171.2"))).toMatchObject({
      instruction: "",
      subject: { type: "chat", ref: "D0SAM/171.2" },
    });

    expect(run(addressed, chat())).toMatchObject({ subject: { type: "chat", ref: "D0SAM" } });
    const ticket = event("chat.message", {
      subject: { ticket: "ACME-1" },
      data: { addressed: "sam" },
    });

    expect(run(addressed, ticket)).toMatchObject({ subject: { type: "ticket", ref: "ACME-1" } });
    const doc = event("chat.message", { subject: { doc: "doc-7" }, data: { addressed: "sam" } });
    expect(run(addressed, doc)).toMatchObject({ subject: { type: "doc", ref: "doc-7" } });
    expect(run(addressed, event("chat.message", { data: { addressed: "sam" } }))).toEqual({
      type: "drop",
      policy: "p",
      reason: "the event has no ticket, pull request, document or chat thread",
    });
  });

  it("wakes an idle agent on its oldest ready ticket, or drops", () => {
    const next = policy(
      { wake: { person: "actor", kind: "assigned", subject: "next_ready_ticket" } },
      "Start {{next.ticket}}.",
    );

    const idle = event("agent.idle", { actor: { kind: "agent", id: "sam" } });
    const world = {
      ready: {
        sam: [
          { key: "ACME-2", readyAt: "2026-10-05T08:00:00.000Z" },
          { key: "ACME-3", readyAt: "2026-10-05T07:00:00.000Z" },
        ],
      },
    };

    expect(run(next, idle, world)).toMatchObject({
      type: "wake",
      instruction: "Start ACME-3.",
      subject: { type: "ticket", ref: "ACME-3" },
    });

    expect(run(next, idle)).toEqual({
      type: "drop",
      policy: "p",
      reason: "no ready ticket is assigned to sam",
    });
  });
});

describe("decide: act", () => {
  const handBack = policy({
    act: { as: "actor", ops: [{ move: "review" }, { assign: "requester" }] },
  });

  const sam = { kind: "agent" as const, id: "sam" };

  it("acts as the agent with every change that is still needed", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-1" }, actor: sam });
    expect(run(handBack, e, onTicket())).toEqual({
      type: "act",
      policy: "p",
      as: "sam",
      ops: [
        { op: "move", ticket: "ACME-1", to: "review" },
        { op: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
      ],
    });
  });

  it("falls back to the team's first human, and drops when nothing is left to change", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-9" }, actor: sam });
    const world = { tickets: { "ACME-9": { status: "review" as const } } };
    expect(run(handBack, e, world)).toMatchObject({
      ops: [{ op: "assign", ticket: "ACME-9", to: { kind: "human", id: "ada.admin" } }],
    });

    expect(run(handBack, e, world, { people: OPTS.people })).toEqual({
      type: "drop",
      policy: "p",
      reason:
        "nothing to change: move: ACME-9 is already review; assign: ACME-9 has no known requester and the team lists no human",
    });

    const one = event("agent.handed_back", { subject: { ticket: "ACME-1" }, actor: sam });
    expect(run(handBack, one, onTicket("review", "grace"))).toEqual({
      type: "drop",
      policy: "p",
      reason:
        "nothing to change: move: ACME-1 is already review; assign: ACME-1 is already assigned to grace",
    });
  });

  it("assigns the acting agent itself, sets a parent and comments", () => {
    const p = policy({
      act: {
        as: "actor",
        ops: [{ assign: "self" }, { set_parent: true }, { comment: "Split by {{person}}." }],
      },
    });

    const e = event("agent.handed_back", {
      subject: { ticket: "ACME-1" },
      actor: sam,
      data: { parent: "ACME-0" },
    });

    expect(run(p, e, onTicket("active", "grace"))).toMatchObject({
      ops: [
        { op: "assign", ticket: "ACME-1", to: { kind: "agent", id: "sam" } },
        { op: "set_parent", ticket: "ACME-1", parent: "ACME-0" },
        { op: "comment", on: { ticket: "ACME-1" }, body: "Split by sam." },
      ],
    });

    expect(run(p, { ...e, data: {} }, onTicket())).toEqual({
      type: "act",
      policy: "p",
      as: "sam",
      ops: [{ op: "comment", on: { ticket: "ACME-1" }, body: "Split by sam." }],
    });
  });

  it("comments on the document when there is no ticket, and needs a target and a valid template", () => {
    const note = (comment: string) => policy({ act: { as: "actor", ops: [{ comment }] } });
    const onDoc = event("doc.commented", { subject: { doc: "doc-7" }, actor: sam });
    expect(run(note("Noted."), onDoc)).toMatchObject({
      ops: [{ op: "comment", on: { doc: "doc-7" }, body: "Noted." }],
    });

    expect(run(note("Noted."), event("agent.idle", { actor: sam }))).toEqual({
      type: "drop",
      policy: "p",
      reason: "nothing to change: comment: the event has no ticket or document",
    });

    expect(run(note("{{nope}}"), onDoc)).toEqual({
      type: "drop",
      policy: "p",
      reason: 'nothing to change: comment: Unknown template variable "nope".',
    });
  });

  it("needs a ticket for every other change, and an agent to act as", () => {
    const e = event("agent.handed_back", { actor: sam });
    expect(run(handBack, e)).toEqual({
      type: "drop",
      policy: "p",
      reason:
        "nothing to change: move: the event has no linked ticket; assign: the event has no linked ticket",
    });

    const asAuthor = policy({ act: { as: "author", ops: [{ move: "done" }] } });
    expect(run(asAuthor, event("pr.merged", { subject: { pr: prRef(4) } }))).toEqual({
      type: "drop",
      policy: "p",
      reason:
        "no agent to act as (the office never acts as itself): pull request has no agent author",
    });
  });
});

describe("decide: drop", () => {
  it("drops with the policy's reason", () => {
    expect(run(policy({ drop: { reason: "nobody needs it" } }), event("ticket.moved"))).toEqual({
      type: "drop",
      policy: "p",
      reason: "nobody needs it",
    });
  });
});
