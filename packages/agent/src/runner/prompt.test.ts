import { describe, expect, it } from "vitest";
import type { Feedback } from "@outstaff/protocol";
import type { Offer } from "../office-client/index.js";
import { buildWorkPrompt } from "./prompt.js";

const offer = (feedback?: Feedback | Feedback[]): Offer =>
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
      ...(feedback ? { feedback: [feedback].flat() } : {}),
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

  it("lists the inline comments of a review with their threads and links", () => {
    const prompt = buildWorkPrompt(
      offer({
        actor: "grace",
        kind: "review",
        state: "changes_requested",
        body: "",
        comments: [
          {
            id: "101",
            path: "src/a.ts",
            line: 3,
            body: "Rename this.",
            url: "https://g.example/pull/3#r1",
            threadId: "PRRT_1",
          },
          { id: "102", path: "src/b.ts", body: "No thread.\nTwo lines." },
        ],
      }),
      { resumed: false },
    );

    expect(prompt).toContain("Reply in each thread and resolve the ones you fixed");
    expect(prompt).toContain(
      "- src/a.ts:3 (thread PRRT_1, https://g.example/pull/3#r1)\n  > Rename this.",
    );

    expect(prompt).toContain("- src/b.ts (no thread id)\n  > No thread.\n  > Two lines.");
  });

  it("lists every piece of feedback of the round, oldest first", () => {
    const prompt = buildWorkPrompt(
      offer([
        { actor: "ada", kind: "inline_comment", url: "https://g.example/r1", body: "First." },
        { actor: "ada", kind: "inline_comment", url: "https://g.example/r2", body: "Second." },
      ]),
      { resumed: false },
    );

    expect(prompt).toContain("This round covers 2 pieces of feedback, oldest first.");
    const first = prompt.indexOf("Triggered by an inline comment from ada: https://g.example/r1");
    const second = prompt.indexOf("Triggered by an inline comment from ada: https://g.example/r2");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(prompt).toContain("> First.");
    expect(prompt).toContain("> Second.");
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

describe("buildWorkPrompt branch", () => {
  const workspace = { repo: "app", worktree: "/w/app/w7", branch: "feat/x", scratch: "/s/w7" };

  it("tells a round on a pull request to push to its head branch", () => {
    const o = offer();
    o.workItem.subject = { type: "pr", ref: "github.example/acme/app#3" };
    o.context.subjects = [
      { type: "pr", ref: "github.example/acme/app#3", headRef: "feat/x", state: "open", own: true },
    ];

    const prompt = buildWorkPrompt(o, { resumed: false, workspace });
    expect(prompt).toContain("branch feat/x");
    expect(prompt).toContain("head of your open pull request");
    expect(prompt).toContain("git push origin HEAD:feat/x");
  });

  it("leaves new work on its own branch", () => {
    const prompt = buildWorkPrompt(offer(), {
      resumed: false,
      workspace: { ...workspace, branch: "ticket/w7-x" },
    });

    expect(prompt).not.toContain("head of your open pull request");
    expect(prompt).toContain("Commit there and push that branch");
  });
});

describe("buildWorkPrompt chat requests", () => {
  const chatOffer = (kind: string): Offer => {
    const base = offer();
    return {
      ...base,
      workItem: {
        ...base.workItem,
        kind,
        origin: {
          channel: "D1",
          thread: "t1",
          requester: { id: "U1", name: "Ada" },
          direct: true,
          participant: true,
        },
      },
    } as Offer;
  };

  it.each(["chat", "assigned"])(
    "tells a %s item not to greet, address or tag the requester, because the reply goes to their thread",
    (kind) => {
      const prompt = buildWorkPrompt(chatOffer(kind), { resumed: false });
      expect(prompt).toContain("posted in the requester's thread");
      expect(prompt).toContain("Do not greet or address them by name or tag them");
      expect(prompt).not.toContain("mentioning");
    },
  );
});
