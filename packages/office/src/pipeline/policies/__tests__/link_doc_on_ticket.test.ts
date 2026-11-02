import type { PipelineEvent } from "@outstaff/policy";
import type { PipelineOptions } from "#/pipeline/state.types.js";
import { describe, expect, it } from "vitest";
import { describeDecision } from "#/pipeline/describe.js";
import {
  BUILT_IN_POLICIES,
  evaluatePipeline,
  event,
  OPTS,
  SAM,
  stateOf,
  t,
  type World,
} from "./support.js";

const LINKING: PipelineOptions = { ...OPTS, capabilities: ["knowledge.issueLinks"] };

const linked = (actor: PipelineEvent["actor"] = SAM) =>
  event("doc.linked", {
    subject: { doc: "42", ticket: "ACME-9" },
    actor,
    data: { ticket: "ACME-9" },
  });

const world: World = { tickets: { "ACME-9": t("active", "sam") }, docs: { "42": "noor" } };

/** What link_doc_on_ticket decides, with a knowledge base that links documents unless told otherwise. */
function linkOf(e: PipelineEvent, w: World, options: PipelineOptions = LINKING) {
  const trace = evaluatePipeline(e, stateOf(w), BUILT_IN_POLICIES, options);
  return trace.decisions.filter((d) => d.policy === "link_doc_on_ticket");
}

describe("link_doc_on_ticket", () => {
  it("links the document on its ticket as the document's author, with no note", () => {
    const decisions = linkOf(linked(), world);
    expect(decisions.map(describeDecision)).toEqual(["act for noor: link doc 42 on ACME-9"]);
    expect(decisions[0]).toMatchObject({ ops: [{ op: "link_doc", ticket: "ACME-9", doc: "42" }] });
    expect(decisions[0]).not.toHaveProperty("note");
  });

  it("falls back to the agent who linked it when no author is recorded", () => {
    expect(linkOf(linked(), { ...world, docs: {} }).map(describeDecision)).toEqual([
      "act for sam: link doc 42 on ACME-9",
    ]);
  });

  it("drops, saying why, with no agent to act for, or a knowledge base that cannot link", () => {
    expect(
      linkOf(linked({ kind: "human", id: "ada-admin" }), { ...world, docs: {} }),
    ).toMatchObject([
      {
        type: "drop",
        reason:
          "no agent to act for: no agent is recorded as the author of the document; the event was caused by a human, not an agent",
      },
    ]);

    expect(linkOf(linked(), world, OPTS)).toMatchObject([
      {
        type: "drop",
        reason: "the knowledge base cannot link documents on tickets (knowledge.issueLinks)",
      },
    ]);
  });

  it("wakes no one", () => {
    const trace = evaluatePipeline(linked(), stateOf(world), BUILT_IN_POLICIES, LINKING);
    expect(trace.decisions.map(describeDecision)).toEqual(["act for noor: link doc 42 on ACME-9"]);
  });
});
