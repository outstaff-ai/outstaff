import type { Feedback } from "@outstaff/protocol";
import { fakeEnv } from "@outstaff/testing.agent";
import { describe, expect, it } from "vitest";
import { createLessons } from "#/notes/index.js";
import { findVerb, runVerb } from "#/verbs/index.js";
import type { DeclaredHandBack } from "#/verbs/types.js";

/** An item of the given kind with the round's feedback, and the statuses its agent stated. */
function item(kind: string | undefined, feedback: Feedback[] = []) {
  const said: DeclaredHandBack[] = [];
  const messages: (string | undefined)[] = [];
  const { env } = fakeEnv();
  const declare = (s: DeclaredHandBack, message?: string) => {
    said.push(s);
    messages.push(message);
  };

  const lessons = createLessons(feedback);
  const withItem = kind ? { ...env, handBack: { kind, declare, lessons } } : env;
  const run = (status: string, message?: string, flags: { nothingToKeep?: boolean } = {}) =>
    runVerb(
      findVerb("handback")!,
      withItem,
      { status, ...(message === undefined ? {} : { message }), ...flags },
      { workItemId: "w1" },
    );

  return { said, messages, run, lessons };
}

const review: Feedback = {
  actor: "ada-admin",
  from: "human",
  kind: "review",
  body: "You won't get access to the platform repository.",
};

describe("ost handback", () => {
  it("states how the item ends", async () => {
    const i = item("assigned");
    const out = await i.run("blocked");
    await i.run("done");
    expect(i.said).toEqual(["blocked", "done"]);
    expect(JSON.stringify(out)).toContain("handed back as blocked");
  });

  it("takes the agent's message for the human with the status", async () => {
    const i = item("assigned");
    const out = await i.run("done", "  Added the preview step; nothing needed from you.  ");
    await i.run("done");
    expect(i.messages).toEqual(["Added the preview step; nothing needed from you.", undefined]);
    expect(JSON.stringify(out)).toContain("with your message");
    await expect(i.run("done", " ")).rejects.toThrow(/message/);
  });

  it("lets a comment round finish silently", async () => {
    const i = item("ticket_comment");
    await i.run("silent");
    expect(i.said).toEqual(["silent"]);
  });

  it("lets work on a ticket finish silently: the office checks it waits on work in flight", async () => {
    const i = item("assigned");
    await i.run("silent");
    expect(i.said).toEqual(["silent"]);
  });

  it("refuses outside a work item", async () => {
    await expect(item(undefined).run("done")).rejects.toThrow("Only a work item hands back");
  });

  describe("the lesson check", () => {
    it("refuses once when a trusted human reviewed and no note changed", async () => {
      const i = item("review_feedback", [review]);
      await expect(i.run("done")).rejects.toThrow(/ada-admin \(trusted\), and no note changed/);
      expect(i.said).toEqual([]);
      await i.run("done");
      expect(i.said).toEqual(["done"]);
      expect(i.lessons.outcome()).toEqual({
        from: ["ada-admin"],
        refused: true,
        kept: "unanswered",
      });
    });

    it("takes the hand-back when a note was added or changed in the round", async () => {
      const i = item("review_feedback", [review]);
      i.lessons.noted();
      await i.run("done");
      expect(i.said).toEqual(["done"]);
      expect(i.lessons.outcome()).toEqual({ from: ["ada-admin"], refused: false, kept: "noted" });
    });

    it("takes a note kept after the refusal as the answer", async () => {
      const i = item("ticket_comment", [{ ...review, kind: "ticket_comment" }]);
      await expect(i.run("silent")).rejects.toThrow(/ost note add/);
      i.lessons.noted();
      await i.run("silent");
      expect(i.lessons.outcome()).toEqual({ from: ["ada-admin"], refused: true, kept: "noted" });
    });

    it("takes --nothing-to-keep, and the outcome says so", async () => {
      const i = item("review_feedback", [review]);
      await i.run("done", undefined, { nothingToKeep: true });
      expect(i.said).toEqual(["done"]);
      expect(i.lessons.outcome()).toEqual({ from: ["ada-admin"], refused: false, kept: "nothing" });
    });

    it("does not check feedback from agents or automation only", async () => {
      const i = item("review_feedback", [
        { ...review, actor: "mira", from: "agent" },
        { actor: "ci", from: "automation", kind: "ci_failure", body: "test failed" },
        { actor: "sam", from: "agent", kind: "blocked", body: "Needs a key." },
      ]);

      await i.run("done");
      expect(i.said).toEqual(["done"]);
      expect(i.lessons.outcome()).toBeUndefined();
    });

    it("does not check a round without feedback, or a human's chat message", async () => {
      const none = item("assigned");
      await none.run("done");
      expect(none.said).toEqual(["done"]);
      const chat = item("chat", [{ ...review, kind: "chat" }]);
      await chat.run("silent");
      expect(chat.said).toEqual(["silent"]);
      expect(chat.lessons.outcome()).toBeUndefined();
    });

    it("names each trusted human once", async () => {
      const i = item("review_feedback", [
        review,
        { ...review, kind: "inline_comment" },
        { ...review, actor: "grace-lead", kind: "comment" },
      ]);

      await expect(i.run("done")).rejects.toThrow(/ada-admin, grace-lead \(trusted\)/);
    });
  });
});
