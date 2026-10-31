import { describe, expect, it } from "vitest";
import { createPolicyContext } from "#/context.js";
import type { PipelineEvent } from "#/events.types.js";
import type { ActSpec, PolicyOptions, WakeSpec } from "#/policy.types.js";
import { event, OPTS, pr, prRef, stateOf, type World } from "./support.js";

const ctxFor = (
  e: PipelineEvent,
  world: World = {},
  instruction?: string,
  options: PolicyOptions = OPTS,
) =>
  createPolicyContext(
    { id: "p", summary: "test", on: [], decide: () => [], instruction },
    { event: e, state: stateOf(world), options },
    "it matched",
  );

const wake = (spec: WakeSpec, e: PipelineEvent, world?: World, instruction?: string) =>
  ctxFor(e, world, instruction).wake(spec);

const act = (spec: ActSpec, e: PipelineEvent, world?: World, instruction?: string) =>
  ctxFor(e, world, instruction).act(spec);

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

describe("ctx.wake", () => {
  const review: WakeSpec = { person: "author", kind: "review_feedback" };
  const comment = event("pr.comment", { subject: { pr: prRef(9) } });

  it("wakes the person with the rendered instruction, leaving the subject to the event", () => {
    expect(wake(review, comment, { prs: [pr(9)] }, "Look at #{{pr.number}}.")).toEqual([
      {
        type: "wake",
        person: "sam",
        kind: "review_feedback",
        instruction: "Look at #9.",
        reason: "it matched",
      },
    ]);

    expect(ctxFor(comment, { prs: [pr(9)] }).wake(review, "my reason")).toMatchObject([
      { instruction: "", reason: "my reason" },
    ]);
  });

  it("drops when nobody resolves or the instruction cannot be rendered", () => {
    expect(wake(review, comment, {}, "x")).toEqual([
      { type: "drop", reason: "no one to wake: pull request has no agent author" },
    ]);

    expect(wake(review, comment, { prs: [pr(9)] }, "{{nope}}")).toEqual([
      {
        type: "drop",
        reason: 'the instruction cannot be rendered: Unknown template variable "nope".',
      },
    ]);
  });

  it("wakes an idle agent on its next ready ticket, or drops", () => {
    const next: WakeSpec = { person: "actor", kind: "assigned", subject: "next_ready_ticket" };
    const idle = event("agent.idle", { actor: { kind: "agent", id: "sam" } });
    const world = {
      ready: {
        sam: [
          { key: "ACME-2", readyAt: "2026-10-05T08:00:00.000Z" },
          { key: "ACME-3", readyAt: "2026-10-05T07:00:00.000Z" },
        ],
      },
    };

    expect(wake(next, idle, world, "Start {{next.ticket}}.")).toMatchObject([
      { type: "wake", instruction: "Start ACME-3.", subject: { type: "ticket", ref: "ACME-3" } },
    ]);

    expect(wake(next, idle)).toEqual([
      { type: "drop", reason: "no ready ticket is assigned to sam" },
    ]);
  });
});

describe("ctx.act", () => {
  const handBack: ActSpec = { as: "actor", ops: [{ move: "review" }, { assign: "requester" }] };
  const sam = { kind: "agent" as const, id: "sam" };

  it("acts as the agent with every change that is still needed", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-1" }, actor: sam });
    expect(act(handBack, e, onTicket())).toEqual([
      {
        type: "act",
        as: "sam",
        ops: [
          { op: "move", ticket: "ACME-1", to: "review" },
          { op: "assign", ticket: "ACME-1", to: { kind: "human", id: "grace" } },
        ],
        reason: "it matched; assign: ACME-1 to grace, its requester",
      },
    ]);
  });

  it("falls back to the team's first human, and drops when nothing is left to change", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-9" }, actor: sam });
    const world = { tickets: { "ACME-9": { status: "review" as const } } };
    expect(act(handBack, e, world)).toMatchObject([
      {
        ops: [{ op: "assign", ticket: "ACME-9", to: { kind: "human", id: "ada.admin" } }],
        reason:
          "it matched; assign: ACME-9 to ada.admin, the fallback (hand_back.fallback), as no requester is known",
      },
    ]);

    expect(ctxFor(e, world, undefined, { people: OPTS.people }).act(handBack)).toEqual([
      {
        type: "drop",
        reason:
          "nothing to change: move: ACME-9 is already review; assign: ACME-9 has no known requester and the team lists no human with a tracker identity",
      },
    ]);

    const one = event("agent.handed_back", { subject: { ticket: "ACME-1" }, actor: sam });
    expect(act(handBack, one, onTicket("review", "grace"))).toEqual([
      {
        type: "drop",
        reason:
          "nothing to change: move: ACME-1 is already review; assign: ACME-1 is already assigned to grace",
      },
    ]);
  });

  it("assigns the acting agent itself and sets a parent", () => {
    const spec: ActSpec = { as: "actor", ops: [{ assign: "self" }, { set_parent: true }] };
    const e = event("agent.handed_back", {
      subject: { ticket: "ACME-1" },
      actor: sam,
      data: { parent: "ACME-0" },
    });

    expect(act(spec, e, onTicket("active", "grace"))).toMatchObject([
      {
        ops: [
          { op: "assign", ticket: "ACME-1", to: { kind: "agent", id: "sam" } },
          { op: "set_parent", ticket: "ACME-1", parent: "ACME-0" },
        ],
      },
    ]);

    expect(act(spec, { ...e, data: {} }, onTicket())).toEqual([
      {
        type: "drop",
        reason:
          "nothing to change: assign: ACME-1 is already assigned to sam; set_parent: the event names no parent ticket",
      },
    ]);
  });

  it("needs a ticket for every change, and an agent to act as", () => {
    expect(act(handBack, event("agent.handed_back", { actor: sam }))).toEqual([
      {
        type: "drop",
        reason:
          "nothing to change: move: the event has no linked ticket; assign: the event has no linked ticket",
      },
    ]);

    const asAuthor: ActSpec = { as: "author", ops: [{ move: "done" }] };
    expect(act(asAuthor, event("pr.merged", { subject: { pr: prRef(4) } }))).toEqual([
      { type: "drop", reason: "no agent to act for: pull request has no agent author" },
    ]);
  });

  it("posts the policy's note naming the agent, and drops the act when it cannot be rendered", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-1" }, actor: sam });
    const world = { tickets: { "ACME-1": { status: "active" as const } } };
    const move: ActSpec = { as: "actor", ops: [{ move: "review" }] };
    expect(act(move, e, world, "Moved to review: {{person}} handed it back.")).toMatchObject([
      { type: "act", note: "Moved to review: sam handed it back." },
    ]);

    expect(act(move, e, world)).toEqual([
      {
        type: "act",
        as: "sam",
        ops: [{ op: "move", ticket: "ACME-1", to: "review" }],
        reason: "it matched",
      },
    ]);

    expect(act(move, e, world, "{{nope}}")).toEqual([
      { type: "drop", reason: 'the note cannot be rendered: Unknown template variable "nope".' },
    ]);
  });
});

describe("ctx.act, then a wake", () => {
  const takeBack: ActSpec = {
    as: "last_worker",
    ops: [{ assign: "self" }],
    wake: { kind: "assigned" },
  };

  const instruction = "{{ticket}} is yours again, {{person}}.";
  const moved = event("ticket.moved", { subject: { ticket: "ACME-1" }, data: { to: "active" } });
  const handedBack = (assignee: string) => ({
    tickets: {
      "ACME-1": {
        status: "active" as const,
        lastWorker: "sam",
        assignee: {
          id: assignee,
          kind: assignee === "sam" ? ("agent" as const) : ("human" as const),
        },
      },
    },
  });

  it("acts for the agent without a note, then wakes them with the policy's instruction", () => {
    expect(act(takeBack, moved, handedBack("grace"), instruction)).toEqual([
      {
        type: "act",
        as: "sam",
        ops: [{ op: "assign", ticket: "ACME-1", to: { kind: "agent", id: "sam" } }],
        reason: "it matched",
      },
      {
        type: "wake",
        person: "sam",
        kind: "assigned",
        instruction: "ACME-1 is yours again, sam.",
        reason: "it matched",
      },
    ]);
  });

  it("still wakes the agent when nothing is left to change", () => {
    expect(act(takeBack, moved, handedBack("sam"), instruction)).toMatchObject([
      { type: "wake", person: "sam", kind: "assigned" },
    ]);
  });

  it("drops both when no agent has worked on the ticket", () => {
    const world = { tickets: { "ACME-1": { status: "active" as const } } };
    expect(act(takeBack, moved, world, instruction)).toEqual([
      { type: "drop", reason: "no agent to act for: no agent has worked on the ticket yet" },
    ]);
  });
});

describe("the context", () => {
  it("is read-only, checks conditions, resolves people and renders templates", () => {
    const e = event("pr.comment", { subject: { pr: prRef(9) } });
    const ctx = ctxFor(e, { prs: [pr(9)], links: { 9: "ACME-9" } });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.ticket).toBe("ACME-9");
    expect(ctx.pr?.ref.number).toBe(9);
    expect(ctx.settings).toEqual({});
    expect(ctx.check({ actor_kind: "human" }).ok).toBe(true);
    expect(ctx.person("author")).toEqual({ value: "sam" });
    expect(ctx.render("#{{pr.number}} for {{person}}", { person: "sam" })).toEqual({
      value: "#9 for sam",
    });

    expect(ctx.render("{{nope}}")).toEqual({ skip: 'Unknown template variable "nope".' });
  });
});
