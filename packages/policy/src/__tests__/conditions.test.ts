import { describe, expect, it } from "vitest";
import { evaluateCondition } from "#/conditions.js";
import { ctxOf, event, pr, prRef } from "./support.js";

const assigned = {
  tickets: {
    "ACME-1": { status: "ready" as const, assignee: { id: "sam", kind: "agent" as const } },
  },
};

describe("evaluateCondition", () => {
  it("checks workflow leaves with the workflow evaluator and names the failing one", () => {
    const ctx = ctxOf(event("ticket.assigned", { subject: { ticket: "ACME-1" } }), assigned);
    expect(evaluateCondition({ assignee_kind: "agent" }, ctx)).toEqual({
      ok: true,
      detail: "assignee is agent, wanted agent",
    });

    expect(evaluateCondition({ assignee_kind: "human" }, ctx)).toEqual({
      ok: false,
      detail: "assignee is agent, wanted human",
      failed: { assignee_kind: "human" },
    });
  });

  it("returns the first failing condition of an all, however deep", () => {
    const ctx = ctxOf(event("ticket.assigned", { subject: { ticket: "ACME-1" } }), assigned);
    const r = evaluateCondition(
      {
        all: [
          { actor_kind: "human" },
          { all: [{ ticket_status: ["done"] }, { actor_kind: "agent" }] },
        ],
      },
      ctx,
    );

    expect(r.ok).toBe(false);
    expect(r.failed).toEqual({ ticket_status: ["done"] });
    expect(evaluateCondition({ all: [{ actor_kind: "human" }] }, ctx)).toEqual({
      ok: true,
      detail: "all conditions hold",
    });
  });

  it("holds an any when one part holds, and fails it as a whole otherwise", () => {
    const ctx = ctxOf(event("ticket.commented", { subject: { ticket: "ACME-1" } }), assigned);
    expect(
      evaluateCondition({ any: [{ actor_kind: "agent" }, { actor_kind: "human" }] }, ctx).ok,
    ).toBe(true);

    const none = { any: [{ actor_kind: "agent" as const }, { agent_mentioned: true }] };
    expect(evaluateCondition(none, ctx)).toEqual({
      ok: false,
      detail:
        "none of: actor is human, wanted agent; comment mentions no agent, wanted an agent mentioned",
      failed: none,
    });
  });

  it("negates with not", () => {
    const ctx = ctxOf(event("ticket.moved"));
    expect(evaluateCondition({ not: { actor_kind: "agent" } }, ctx)).toEqual({
      ok: true,
      detail: "actor is human, wanted agent, so not-condition holds",
    });

    const not = { not: { actor_kind: "human" as const } };
    expect(evaluateCondition(not, ctx)).toEqual({
      ok: false,
      detail: "not (actor is human, wanted human)",
      failed: not,
    });
  });

  it("knows whether the actor is the assignee, the pull request's author or the document's author", () => {
    const sam = { kind: "agent" as const, id: "sam" };
    const self = ctxOf(
      event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: sam }),
      assigned,
    );

    expect(evaluateCondition({ actor_is: "assignee" }, self)).toEqual({
      ok: true,
      detail: "actor sam is the assignee (sam)",
    });

    const human = {
      tickets: {
        "ACME-1": {
          status: "ready" as const,
          assignee: { id: "ada.admin", kind: "human" as const },
        },
      },
    };

    expect(
      evaluateCondition(
        { actor_is: "assignee" },
        ctxOf(event("ticket.assigned", { subject: { ticket: "ACME-1" }, actor: sam }), human),
      ),
    ).toEqual({
      ok: false,
      detail: "actor sam is not the assignee",
      failed: { actor_is: "assignee" },
    });

    expect(
      evaluateCondition({ actor_is: "assignee" }, ctxOf(event("ticket.assigned", { actor: sam })))
        .ok,
    ).toBe(false);

    const onPr = ctxOf(event("pr.comment", { subject: { pr: prRef(7) }, actor: sam }), {
      prs: [pr(7)],
    });

    expect(evaluateCondition({ actor_is: "author" }, onPr).detail).toBe(
      "actor sam is the author (sam)",
    );

    const onDoc = (actor: { kind: "agent" | "human"; id: string }, doc?: string) =>
      ctxOf(event("doc.commented", { subject: doc ? { doc } : {}, actor }), {
        docs: { "doc-7": "mira" },
      });

    expect(
      evaluateCondition({ actor_is: "doc_author" }, onDoc({ kind: "agent", id: "mira" }, "doc-7"))
        .detail,
    ).toBe("actor mira is the doc author (mira)");

    expect(
      evaluateCondition({ actor_is: "doc_author" }, onDoc({ kind: "agent", id: "mira" })).ok,
    ).toBe(false);

    expect(
      evaluateCondition({ actor_is: "doc_author" }, onDoc({ kind: "human", id: "mira" }, "doc-7"))
        .detail,
    ).toBe("actor mira is not the doc author (mira)");
  });

  it("knows whether the actor is the agent who last worked on the ticket", () => {
    const worked = { tickets: { "ACME-1": { status: "review" as const, lastWorker: "sam" } } };
    const by = (id: string, ticket?: string) =>
      ctxOf(
        event("ticket.moved", {
          subject: ticket ? { ticket } : {},
          actor: { kind: "agent", id },
        }),
        worked,
      );

    expect(evaluateCondition({ actor_is: "last_worker" }, by("sam", "ACME-1"))).toEqual({
      ok: true,
      detail: "actor sam is the last worker (sam)",
    });

    expect(evaluateCondition({ actor_is: "last_worker" }, by("noor", "ACME-1")).ok).toBe(false);
    expect(evaluateCondition({ actor_is: "last_worker" }, by("sam")).ok).toBe(false);
  });

  it("knows whether the actor is the agent blocked on the ticket", () => {
    const stuck = { tickets: { "ACME-1": { status: "blocked" as const, blockedAgent: "sam" } } };
    const by = (id: string, ticket?: string) =>
      ctxOf(
        event("ticket.commented", {
          subject: ticket ? { ticket } : {},
          actor: { kind: "agent", id },
        }),
        stuck,
      );

    expect(evaluateCondition({ actor_is: "blocked_agent" }, by("sam", "ACME-1"))).toEqual({
      ok: true,
      detail: "actor sam is the blocked agent (sam)",
    });

    expect(evaluateCondition({ actor_is: "blocked_agent" }, by("noor", "ACME-1")).ok).toBe(false);
    expect(evaluateCondition({ actor_is: "blocked_agent" }, by("sam")).ok).toBe(false);
  });
});
