import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, SAM, event, judge, traceOf } from "./support.js";

const ID = "doc_comment_to_mentioned_agent";

describe("doc_comment_to_mentioned_agent", () => {
  const world = { docs: { "doc-7": "mira" } };
  const comment = (actor: PipelineEvent["actor"] = SAM, data: Record<string, unknown> = {}) =>
    event("doc.commented", {
      subject: { doc: "doc-7" },
      actor,
      data: { title: "Order events", ...data },
    });

  const wakes = (e: ReturnType<typeof comment>) =>
    traceOf(e, world).decisions.flatMap((d) =>
      d.type === "wake" ? [`${d.policy}: wake ${d.person}`] : [],
    );

  it("an agent's comment wakes the agent it mentions", () => {
    expect(judge(ID, comment(SAM, { mentions: ["leo"] }), world)).toEqual([
      "wake leo (doc_feedback) on doc doc-7",
    ]);

    expect(wakes(comment(SAM, { mentions: ["leo"] }))).toEqual([
      "doc_comment_to_mentioned_agent: wake leo",
    ]);
  });

  it("an agent's comment that mentions no other agent wakes no one, not even the author", () => {
    expect(judge(ID, comment(), world)).toEqual({ failed: { agent_mentioned: true } });
    expect(wakes(comment())).toEqual([]);
  });

  it("a human's mention wakes one agent, through doc_comment_to_agent", () => {
    expect(wakes(comment(ADA, { mentions: ["leo"] }))).toEqual(["doc_comment_to_agent: wake leo"]);
  });
});
