import { describe, expect, it } from "vitest";
import { engineRecord, fromDecisions, fromEffect } from "#/pipeline/compare/outcomes.js";

const pr = { repo: { host: "github.com", owner: "acme-example", name: "shop" }, number: 9 };

describe("fromEffect", () => {
  it("maps every engine effect, a schedule's subject by pull request, ticket, then document", () => {
    const schedule = {
      type: "schedule" as const,
      person: "sam",
      kind: "conflict",
      priority: "high" as const,
    };

    expect(fromEffect({ ...schedule, pr, ticket: "ACME-1" })).toEqual({
      type: "wake",
      person: "sam",
      kind: "rebase",
      subject: { type: "pr", ref: "acme-example/shop#9" },
    });

    expect(fromEffect({ ...schedule, kind: "assigned", ticket: "ACME-1" })).toMatchObject({
      kind: "assigned",
      subject: { type: "ticket", ref: "ACME-1" },
    });

    expect(fromEffect({ ...schedule, doc: "doc-7" })).toMatchObject({
      subject: { type: "doc", ref: "doc-7" },
    });

    expect(fromEffect(schedule)).toMatchObject({ subject: undefined });
    expect(fromEffect({ type: "move", ticket: "ACME-1", to: "done" })).toEqual({
      type: "move",
      ticket: "ACME-1",
      to: "done",
      as: "office",
    });

    expect(fromEffect({ type: "assign", ticket: "ACME-1", to: null })).toEqual({
      type: "assign",
      ticket: "ACME-1",
      to: null,
      as: "office",
    });

    expect(
      fromEffect({ type: "comment", on: { ticket: "ACME-1" }, template: "t", body: "b" }),
    ).toEqual({ type: "comment", on: "ACME-1", as: "office" });

    expect(fromEffect({ type: "comment", on: { pr }, template: "t", body: "b" })).toEqual({
      type: "comment",
      on: "acme-example/shop#9",
      as: "office",
    });
  });
});

describe("fromDecisions", () => {
  it("maps wakes and each op of an act; drops do nothing", () => {
    expect(
      fromDecisions([
        {
          type: "wake",
          policy: "p",
          person: "sam",
          kind: "assigned",
          instruction: "",
          feedback: [],
          subject: { type: "ticket", ref: "ACME-1" },
        },
        {
          type: "act",
          policy: "q",
          as: "sam",
          ops: [
            { op: "move", ticket: "ACME-1", to: "review" },
            { op: "assign", ticket: "ACME-1", to: { kind: "human", id: "ada.admin" } },
            { op: "comment", on: { ticket: "ACME-1" }, body: "x" },
            { op: "comment", on: { doc: "doc-7" }, body: "x" },
            { op: "set_parent", ticket: "ACME-1", parent: "ACME-0" },
          ],
        },
        { type: "drop", reason: "nothing" },
      ]),
    ).toEqual([
      {
        type: "wake",
        person: "sam",
        kind: "assigned",
        subject: { type: "ticket", ref: "ACME-1" },
        policy: "p",
      },
      { type: "move", ticket: "ACME-1", to: "review", as: "sam", policy: "q" },
      {
        type: "assign",
        ticket: "ACME-1",
        to: { kind: "human", id: "ada.admin" },
        as: "sam",
        policy: "q",
      },
      { type: "comment", on: "ACME-1", as: "sam", policy: "q" },
      { type: "comment", on: "doc-7", as: "sam", policy: "q" },
      { type: "set_parent", ticket: "ACME-1", parent: "ACME-0", as: "sam", policy: "q" },
    ]);
  });
});

describe("engineRecord", () => {
  it("counts a schedule skipped because the work already exists as done", () => {
    const schedule = {
      type: "schedule" as const,
      person: "sam",
      kind: "assigned",
      priority: "normal" as const,
      ticket: "ACME-1",
    };

    const at = "2026-10-05T09:00:00.000Z";
    expect(
      engineRecord([
        {
          effect: schedule,
          status: "skipped",
          note: "work item w1 (assigned) is already active",
          at,
        },
        {
          effect: { ...schedule, person: "noor" },
          status: "skipped",
          note: "noor caused the event themselves",
          at,
        },
      ]),
    ).toEqual({
      effects: [
        {
          type: "wake",
          person: "sam",
          kind: "assigned",
          subject: { type: "ticket", ref: "ACME-1" },
        },
      ],
      skipped: [
        {
          outcome: {
            type: "wake",
            person: "noor",
            kind: "assigned",
            subject: { type: "ticket", ref: "ACME-1" },
          },
          note: "noor caused the event themselves",
        },
      ],
    });
  });

  it("keeps what was applied, and notes what was skipped or failed", () => {
    const move = { type: "move" as const, ticket: "ACME-1", to: "review" as const };
    const at = "2026-10-05T09:00:00.000Z";
    expect(engineRecord([{ effect: move, status: "applied", note: "moved", at }])).toEqual({
      effects: [{ type: "move", ticket: "ACME-1", to: "review", as: "office" }],
    });

    expect(
      engineRecord([
        { effect: move, status: "skipped", note: "no tracker", at },
        { effect: move, status: "failed", note: "forbidden", at },
      ]),
    ).toEqual({
      effects: [],
      skipped: [
        {
          outcome: { type: "move", ticket: "ACME-1", to: "review", as: "office" },
          note: "no tracker",
        },
      ],
      failed: [
        {
          outcome: { type: "move", ticket: "ACME-1", to: "review", as: "office" },
          note: "forbidden",
        },
      ],
    });
  });
});
