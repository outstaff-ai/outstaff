import { buildWorkPrompt, type Offer } from "@outstaff/agent";
import { describe, expect, it } from "vitest";
import { parsePrompt } from "./prompt.js";

const offer = (kind: string): Offer =>
  ({
    workItem: { id: "w7", kind, title: "Add a greeting", priority: 1, trigger: "human" },
    context: {
      subjects: [
        { type: "ticket", ref: "SHOP-1", title: "Add a greeting", url: "http://t.example/SHOP-1" },
        { type: "pr", ref: "github.acme.example/acme/shop#3", url: "https://g.example/pull/3" },
      ],
      links: [],
      journal: [{ at: "2026-01-01T00:00:00Z", author: "office", text: "An earlier note." }],
    },
  }) as unknown as Offer;

// The scripts read the prompt the agent builds. This keeps them in step with its template.
describe("parsePrompt", () => {
  it("reads what the agent's work prompt says", () => {
    const prompt = buildWorkPrompt(offer("review_feedback"), {
      resumed: false,
      workspace: {
        repo: "shop",
        worktree: "/home/outstaff/worktrees/shop/w7",
        branch: "review_feedback/w7-add-a-greeting",
        scratch: "/home/outstaff/scratch/w7",
      },
    });

    expect(parsePrompt(prompt)).toEqual({
      itemId: "w7",
      kind: "review_feedback",
      title: "Add a greeting",
      ticket: "SHOP-1",
      pr: 3,
      worktree: "/home/outstaff/worktrees/shop/w7",
      repo: "shop",
      branch: "review_feedback/w7-add-a-greeting",
      scratch: "/home/outstaff/scratch/w7",
      journal: expect.stringContaining("An earlier note."),
      feedback: [],
    });
  });

  it("reads the feedback that started a review round", () => {
    const o = offer("review_feedback");
    o.context.feedback = [
      {
        actor: "grace",
        kind: "review",
        state: "commented",
        url: "https://g.example/pull/3#pullrequestreview-1",
        body: "Keep it short.\nOne line.",
      },
      { actor: "grace", kind: "comment", url: "https://g.example/pull/3#c2", body: "Also this." },
    ];

    expect(parsePrompt(buildWorkPrompt(o, { resumed: false }))?.feedback).toEqual([
      {
        kind: "review",
        url: "https://g.example/pull/3#pullrequestreview-1",
        body: "Keep it short.\nOne line.",
        threads: [],
      },
      { kind: "comment", url: "https://g.example/pull/3#c2", body: "Also this.", threads: [] },
    ]);
  });

  it("reads the threads of a review's inline comments", () => {
    const o = offer("review_feedback");
    o.context.feedback = [
      {
        actor: "grace",
        kind: "review",
        state: "changes_requested",
        body: "",
        comments: [
          {
            id: "1",
            path: "a.txt",
            line: 1,
            body: "One.",
            url: "https://g.example/r1",
            threadId: "PRRT_1",
          },
          { id: "2", path: "b.txt", body: "Two.", threadId: "PRRT_2" },
          { id: "3", path: "c.txt", body: "No thread." },
        ],
      },
    ];

    expect(parsePrompt(buildWorkPrompt(o, { resumed: false }))?.feedback[0]).toMatchObject({
      body: "",
      threads: ["PRRT_1", "PRRT_2"],
    });
  });

  it("says nothing about a prompt that is not a work prompt", () => {
    expect(parsePrompt("Reply with the word ok.")).toBeUndefined();
  });
});
