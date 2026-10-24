import { describe, expect, it } from "vitest";
import type { Offer } from "../office-client/index.js";
import { buildWorkPrompt } from "./prompt.js";

const offer = (feedback?: Offer["context"]["feedback"]): Offer =>
  ({
    workItem: {
      id: "w7",
      kind: "review_feedback",
      title: "Review feedback",
      priority: 1,
      trigger: "human",
    },
    context: {
      subjects: [{ type: "pr", ref: "github.example/acme/app#3", url: "https://g.example/pull/3" }],
      links: [],
      journal: [],
      ...(feedback ? { feedback } : {}),
    },
  }) as unknown as Offer;

describe("buildWorkPrompt feedback", () => {
  it("names who, what kind, the link and the body of a review that started the round", () => {
    const prompt = buildWorkPrompt(
      offer({
        actor: "grace",
        kind: "review",
        state: "changes_requested",
        url: "https://g.example/pull/3#pullrequestreview-1",
        body: "Please rename it.\nAnd add a test.",
      }),
      { resumed: false },
    );

    expect(prompt).toContain(
      "Triggered by a review (changes requested) from grace: https://g.example/pull/3#pullrequestreview-1",
    );

    expect(prompt).toContain("data from that person");
    expect(prompt).toContain("> Please rename it.\n> And add a test.");
  });

  it("names a conversation comment and an inline comment", () => {
    const comment = buildWorkPrompt(
      offer({ actor: "ada", kind: "comment", url: "https://g.example/pull/3#c1", body: "Why?" }),
      { resumed: false },
    );

    expect(comment).toContain("Triggered by a comment on the pull request conversation from ada");
    const inline = buildWorkPrompt(offer({ actor: "ada", kind: "inline_comment", body: "x" }), {
      resumed: false,
    });

    expect(inline).toContain("Triggered by an inline comment from ada.");
  });

  it("says when a review has no text, and says nothing without feedback", () => {
    const empty = buildWorkPrompt(
      offer({ actor: "grace", kind: "review", state: "approved", body: "" }),
      {
        resumed: false,
      },
    );

    expect(empty).toContain("> (no text)");
    expect(buildWorkPrompt(offer(), { resumed: false })).not.toContain("Triggered by");
  });
});
