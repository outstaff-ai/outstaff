import type { PipelineEvent } from "@outstaff/policy";
import type { PipelineOptions } from "#/pipeline/state.types.js";
import { describe, expect, it } from "vitest";
import { describeDecision } from "#/pipeline/describe.js";
import {
  BUILT_IN_POLICIES,
  evaluatePipeline,
  HUMAN_AUTHOR,
  onPr,
  OPTS,
  prWorld,
  SAM,
  stateOf,
  type World,
} from "./support.js";

const LINKING: PipelineOptions = { ...OPTS, capabilities: ["tracker.development"] };

/** What link_pr_on_ticket decides, with a tracker that links pull requests unless told otherwise. */
function linkOf(e: PipelineEvent, world: World, options: PipelineOptions = LINKING) {
  const trace = evaluatePipeline(e, stateOf(world), BUILT_IN_POLICIES, options);
  return trace.decisions.filter((d) => d.policy === "link_pr_on_ticket");
}

describe("link_pr_on_ticket", () => {
  it("links an agent's pull request on its ticket, as the author, when it is opened or linked later", () => {
    const url = "https://git.acme.example/acme-example/shop/pull/9";
    for (const type of ["pr.opened", "pr.linked"] as const) {
      const decisions = linkOf(onPr(type, {}, SAM), prWorld({ url }, "active"));
      expect(decisions.map(describeDecision)).toEqual([
        "act for sam: link acme-example/shop#9 on ACME-9",
      ]);

      expect(decisions[0]).toMatchObject({
        ops: [{ op: "link_pr", ticket: "ACME-9", pr: { number: 9, url } }],
      });

      expect(decisions[0]).not.toHaveProperty("note");
    }
  });

  it("links a draft too: the ticket shows work in progress", () => {
    expect(
      linkOf(onPr("pr.opened", {}, SAM), prWorld({ draft: true }, "active")).map(describeDecision),
    ).toEqual(["act for sam: link acme-example/shop#9 on ACME-9"]);
  });

  it("drops, saying why, for a human's pull request, one with no ticket, or a tracker that cannot link", () => {
    const opened = onPr("pr.opened", {}, SAM);
    expect(linkOf(onPr("pr.opened"), prWorld({ author: HUMAN_AUTHOR }))).toMatchObject([
      { type: "drop", reason: "no agent to act for: pull request has no agent author" },
    ]);

    expect(linkOf(opened, { ...prWorld(), links: {} })).toMatchObject([
      { type: "drop", reason: "nothing to change: link_pr: the event has no linked ticket" },
    ]);

    expect(linkOf(opened, prWorld(), OPTS)).toMatchObject([
      { type: "drop", reason: "the tracker cannot link pull requests (tracker.development)" },
    ]);
  });

  it("wakes no one", () => {
    const trace = evaluatePipeline(
      onPr("pr.linked", {}, { kind: "automation", id: "workstate" }),
      stateOf(prWorld({}, "active")),
      BUILT_IN_POLICIES,
      LINKING,
    );

    expect(trace.decisions.map(describeDecision)).toEqual([
      "act for sam: link acme-example/shop#9 on ACME-9",
    ]);
  });
});
