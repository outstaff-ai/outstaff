import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_VARIABLES,
  instructionProblem,
  instructionVariables,
  renderInstruction,
} from "#/instructions.js";
import { createEvaluationContext } from "@outstaff/core";
import { ctxOf, event, OPTS, pr, prRef, stateOf } from "./support.js";

describe("instruction variables", () => {
  it("names the merge that caused a derived event and what is wrong with the pull request", () => {
    const e = event("pr.conflicted", {
      subject: { pr: prRef(51) },
      data: { cause: { pr: prRef(50), title: "Cart totals" } },
    });

    const vars = instructionVariables(ctxOf(e, { prs: [pr(51)] }), { person: "sam" });
    expect(vars).toMatchObject({
      person: "sam",
      "pr.number": "51",
      "pr.problem": "conflicts with its base branch",
      cause: " after #50 (Cart totals) merged",
      "cause.number": "50",
      "cause.title": "Cart totals",
      "next.ticket": "",
    });

    expect(Object.keys(vars).toSorted()).toEqual([...INSTRUCTION_VARIABLES].toSorted());
  });

  it("leaves what the event does not carry empty", () => {
    const vars = instructionVariables(
      ctxOf(event("agent.idle", { data: { cause: "not a cause" } })),
      {
        next: "ACME-161",
      },
    );

    expect(vars).toMatchObject({
      person: "",
      "doc.title": "",
      "pr.problem": "",
      cause: "",
      "cause.number": "",
      "cause.title": "",
      "next.ticket": "ACME-161",
    });
  });

  it("names the requester of the ticket, else the team's first human", () => {
    const e = event("agent.handed_back", { subject: { ticket: "ACME-9" } });
    const asked = { tickets: { "ACME-9": { status: "blocked" as const, requester: "grace" } } };
    expect(instructionVariables(ctxOf(e, asked), {}).requester).toBe("grace");
    expect(instructionVariables(ctxOf(e), {}).requester).toBe("ada.admin");
    expect(instructionVariables(ctxOf(event("agent.idle")), {}).requester).toBe("ada.admin");
    const { fallbackRequester: _, ...noHuman } = OPTS;
    const none = createEvaluationContext(e, stateOf(), noHuman);
    expect(instructionVariables(none, {}).requester).toBe("");
  });

  it("titles a document by the event's title, else its id", () => {
    const titled = event("doc.commented", {
      subject: { doc: "doc-7" },
      data: { title: "Order events" },
    });

    expect(instructionVariables(ctxOf(titled), {})["doc.title"]).toBe("Order events");
    const untitled = event("doc.commented", { subject: { doc: "doc-7" } });
    expect(instructionVariables(ctxOf(untitled), {})["doc.title"]).toBe("doc-7");
  });
});

describe("renderInstruction and instructionProblem", () => {
  it("renders and trims", () => {
    expect(renderInstruction("  Start {{next.ticket}}. ", { "next.ticket": "ACME-1" })).toBe(
      "Start ACME-1.",
    );
  });

  it("finds unknown variables and malformed placeholders", () => {
    expect(instructionProblem("Fix #{{pr.number}}{{cause}}.")).toBeUndefined();
    expect(instructionProblem("Hi {{nobody}} and {{pr.nope}}")).toBe(
      "unknown variable nobody, pr.nope",
    );

    expect(instructionProblem("Hi {{ broken")).toBe("Malformed placeholder; use {{name}}.");
  });
});
