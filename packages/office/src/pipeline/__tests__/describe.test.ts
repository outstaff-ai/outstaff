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
});
