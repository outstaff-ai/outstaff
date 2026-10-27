import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_VARIABLES,
  instructionProblem,
  instructionVariables,
  renderInstruction,
} from "#/pipeline/instructions.js";
import { ctxOf, event, pr, prRef } from "./support.js";

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
