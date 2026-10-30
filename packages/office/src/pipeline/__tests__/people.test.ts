import { describe, expect, it } from "vitest";
import { resolveSpec } from "#/pipeline/people.js";
import { ctxOf, event, OPTS, pr, prRef } from "./support.js";

describe("resolveSpec", () => {
  it("names the agent who caused the event, and only an agent", () => {
    const byAgent = ctxOf(event("agent.idle", { actor: { kind: "agent", id: "sam" } }));
    expect(resolveSpec("actor", byAgent, OPTS)).toEqual({ value: "sam" });
    expect(resolveSpec("actor", ctxOf(event("agent.idle")), OPTS)).toEqual({
      skip: "the event was caused by a human, not an agent",
    });
  });

  it("names the agent a chat message is addressed to", () => {
    const to = (addressed: unknown) => ctxOf(event("chat.message", { data: { addressed } }));
    expect(resolveSpec("addressed", to("sam"), OPTS)).toEqual({ value: "sam" });
    expect(resolveSpec("addressed", to(""), OPTS)).toEqual({
      skip: "the message is addressed to no agent",
    });

    expect(resolveSpec("addressed", to(undefined), OPTS)).toEqual({
      skip: "the message is addressed to no agent",
    });
  });

  it("resolves workflow people through the workflow evaluator", () => {
    const ctx = ctxOf(event("pr.comment", { subject: { pr: prRef(3) } }), { prs: [pr(3)] });
    expect(resolveSpec("author", ctx, OPTS)).toEqual({ value: "sam" });
    expect(
      resolveSpec("role:pm", ctxOf(event("ticket.created"), { roles: { pm: "priya" } }), OPTS),
    ).toEqual({
      value: "priya",
    });
  });

  it("names the agent who last worked on the ticket", () => {
    const comment = event("ticket.commented", { subject: { ticket: "ACME-1" } });
    const worked = { tickets: { "ACME-1": { status: "review" as const, lastWorker: "sam" } } };
    expect(resolveSpec("last_worker", ctxOf(comment, worked), OPTS)).toEqual({ value: "sam" });
    expect(resolveSpec("last_worker", ctxOf(comment), OPTS)).toEqual({
      skip: "no agent has worked on the ticket yet",
    });
  });

  it("tries a list in order and says why none resolved", () => {
    const mentioned = ctxOf(event("ticket.commented", { data: { mentions: ["mira"] } }));
    expect(resolveSpec(["mentioned", "assignee"], mentioned, OPTS)).toEqual({ value: "mira" });
    expect(resolveSpec(["mentioned", "assignee"], ctxOf(event("ticket.commented")), OPTS)).toEqual({
      skip: "the comment mentions no agent; ticket is not assigned to an agent",
    });
  });

  it("refuses anyone who is not an agent on the team", () => {
    const ctx = ctxOf(event("chat.message", { data: { addressed: "someone-else" } }));
    expect(resolveSpec("addressed", ctx, OPTS)).toEqual({
      skip: "someone-else (addressed) is not an agent on the team",
    });
  });
});
