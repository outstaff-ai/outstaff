import { describe, expect, it } from "vitest";
import { describeDecision, describeOp, formatTrace, subjectOf } from "#/pipeline/describe.js";
import type { Trace } from "#/pipeline/trace.types.js";
import { event, prRef } from "./support.js";

describe("describeOp and describeDecision", () => {
  it("say what each tracker change and decision does", () => {
    expect(describeOp({ op: "move", ticket: "ACME-1", to: "done" })).toBe("move ACME-1 to done");
    expect(
      describeOp({ op: "assign", ticket: "ACME-1", to: { kind: "human", id: "ada.admin" } }),
    ).toBe("assign ACME-1 to human ada.admin");

    expect(describeOp({ op: "assign", ticket: "ACME-1", to: null })).toBe("unassign ACME-1");
    expect(describeOp({ op: "comment", on: { ticket: "ACME-1" }, body: "x" })).toBe(
      "comment on ACME-1",
    );

    expect(describeOp({ op: "comment", on: { doc: "doc-7" }, body: "x" })).toBe(
      "comment on doc doc-7",
    );

    expect(describeOp({ op: "set_parent", ticket: "ACME-2", parent: "ACME-1" })).toBe(
      "set the parent of ACME-2 to ACME-1",
    );

    expect(describeDecision({ type: "drop", reason: "no policy matched" })).toBe(
      "drop: no policy matched",
    );
  });
});

describe("subjectOf", () => {
  it("names a chat channel and thread, else the pull request, ticket or document", () => {
    expect(
      subjectOf(event("chat.message", { subject: { chat: { channel: "D0SAM", thread: "17.1" } } })),
    ).toBe("chat D0SAM/17.1");

    expect(subjectOf(event("chat.message", { subject: { chat: { channel: "D0SAM" } } }))).toBe(
      "chat D0SAM",
    );

    expect(
      subjectOf(
        event("chat.message", { subject: { chat: { channel: "D0SAM" }, ticket: "ACME-1" } }),
      ),
    ).toBe("ACME-1");

    expect(subjectOf(event("pr.merged", { subject: { pr: prRef(4) } }))).toBe(
      "acme-example/shop#4",
    );
  });
});

describe("formatTrace", () => {
  it("lists the policies that listen, why each matched or not, the deaf ones in one line, and the decisions", () => {
    const trace: Trace = {
      event: event("pr.comment", { id: "vcs:c-1", subject: { pr: prRef(9) } }),
      policies: [
        {
          policy: "review_to_author",
          matched: true,
          reason: "all conditions hold",
          decisions: [
            {
              type: "wake",
              policy: "review_to_author",
              person: "sam",
              kind: "review_feedback",
              instruction: "Address it.",
              feedback: [],
              subject: { type: "pr", ref: "acme-example/shop#9" },
            },
          ],
        },
        {
          policy: "merged_feedback_to_author",
          matched: false,
          reason: "pull request is open, wanted merged",
          failed: { pr_merged: true },
          decisions: [],
        },
        {
          policy: "chat_to_addressed",
          matched: false,
          reason: "listens to chat.message, not pr.comment",
          decisions: [],
        },
      ],
      decisions: [],
    };

    trace.decisions = trace.policies[0]!.decisions;
    expect(formatTrace(trace)).toBe(
      [
        "pr.comment on acme-example/shop#9 by human ada-admin at 2026-10-05T09:00:00.000Z",
        "event vcs:c-1",
        "",
        "Policies:",
        "  matched  review_to_author: all conditions hold",
        "           -> wake sam (review_feedback) on pr acme-example/shop#9",
        "  no       merged_feedback_to_author: pull request is open, wanted merged",
        '           failing condition: {"pr_merged":true}',
        "",
        "Not listening to pr.comment: chat_to_addressed",
        "",
        "Decisions:",
        "  wake sam (review_feedback) on pr acme-example/shop#9",
        "    instruction: Address it.",
      ].join("\n"),
    );
  });

  it("adds what the engine did and the comparison, in shadow mode", () => {
    const trace: Trace = {
      event: event("ticket.assigned", { id: "tracker:2", subject: { ticket: "ACME-1" } }),
      policies: [],
      decisions: [{ type: "drop", reason: "no policy matched" }],
      engine: { effects: [{ type: "move", ticket: "ACME-1", to: "active", as: "office" }] },
      comparison: {
        agree: false,
        differences: [
          {
            kind: "missing_in_pipeline",
            engine: { type: "move", ticket: "ACME-1", to: "active", as: "office" },
          },
        ],
      },
    };

    expect(formatTrace(trace).split("\n").slice(-7)).toEqual([
      "  drop: no policy matched",
      "",
      "Engine (today):",
      "  move ACME-1 to active (by the office)",
      "",
      "Comparison: differ",
      "  missing_in_pipeline: engine: move ACME-1 to active (by the office)",
    ]);
  });

  it("prints a gated event with no policies", () => {
    const trace: Trace = {
      event: event("ticket.assigned", { id: "tracker:1", subject: { ticket: "ACME-1" } }),
      policies: [],
      decisions: [{ type: "drop", reason: "the event comes from someone who is not trusted" }],
    };

    expect(formatTrace(trace)).toBe(
      [
        "ticket.assigned on ACME-1 by human ada-admin at 2026-10-05T09:00:00.000Z",
        "event tracker:1",
        "",
        "Decisions:",
        "  drop: the event comes from someone who is not trusted",
      ].join("\n"),
    );
  });

  it("names the item each wake queued, or was folded into with that item's events", () => {
    const wake = {
      type: "wake" as const,
      policy: "chat_to_addressed",
      person: "sam",
      kind: "chat",
      instruction: "Answer.",
      feedback: [],
      subject: { type: "chat" as const, ref: "D-1" },
    };

    const trace: Trace = {
      event: event("chat.message", { id: "chat:sam:D-1:3", subject: { chat: { channel: "D-1" } } }),
      policies: [],
      decisions: [
        wake,
        { ...wake, itemId: "w-1" },
        { ...wake, itemId: "w-1", folded: ["chat:sam:D-1:1", "chat:sam:D-1:3"] },
      ],
    };

    expect(formatTrace(trace).split("\n").slice(4)).toEqual([
      "  wake sam (chat) on chat D-1",
      "    instruction: Answer.",
      "  wake sam (chat) on chat D-1",
      "    instruction: Answer.",
      "    queued work item w-1",
      "  wake sam (chat) on chat D-1",
      "    instruction: Answer.",
      "    folded into work item w-1, with the events chat:sam:D-1:1, chat:sam:D-1:3",
    ]);
  });

  it("says what each wake's bundle carried, item by item", () => {
    const limits = { comments: 5, messages: 10, threads: 5, items: 2, bodyChars: 1500 };
    const trace: Trace = {
      event: event("pr.comment", { id: "vcs:1", subject: { ticket: "ACME-1" } }),
      policies: [],
      decisions: [],
      context: {
        "item-1": {
          itemId: "item-1",
          omitted: 1,
          limits,
          entries: [
            {
              type: "pr",
              ref: "acme/app#12",
              url: "https://git.acme.example/acme/app/pull/12",
              why: { role: "subject", source: "vcs:1" },
              shown: 1,
              left: 2,
            },
            {
              type: "chat_thread",
              ref: "D1:1",
              why: { role: "linked", source: "chat thread of work item item-0" },
              shown: 3,
              left: 0,
            },
          ],
        },
        "item-2": {
          itemId: "item-2",
          omitted: 0,
          limits,
          entries: [{ type: "doc", ref: "doc-1", why: { role: "created", source: "doc_link" } }],
        },
      },
    };

    expect(formatTrace(trace).split("\n").slice(-7)).toEqual([
      "",
      "Context handed over:",
      "  work item item-1: 2 linked, 1 left out by pipeline.context.items",
      "    pr acme/app#12 (subject: vcs:1, 1 shown, 2 left out) https://git.acme.example/acme/app/pull/12",
      "    chat_thread D1:1 (linked: chat thread of work item item-0, 3 shown)",
      "  work item item-2: 1 linked",
      "    doc doc-1 (created: doc_link)",
    ]);

    expect(formatTrace({ ...trace, context: {} })).not.toContain("Context handed over");
  });
});
