import { describe, expect, it } from "vitest";
import { DECIDE_GATE } from "#/decide.js";
import { parsePrompt } from "#/prompt.js";
import { assigned, SCRIPTS, type Action } from "#/scripts.js";

const base = {
  itemId: "w9",
  kind: "assigned",
  title: "assigned: SHOP-41 Decide with the PM: the cache size",
  ticket: "SHOP-41",
  worktree: "/wt",
  repo: "shop",
  journal: "",
  feedback: [],
  conventionFiles: [],
};

const shown = "SHOP-41: Decide with the PM: the cache size\nStatus: In Progress";

/** Plays a script, answering each tool call by its name, and returns what it did and its final message. */
async function play(script: AsyncGenerator<Action, string, string>) {
  const done: Action[] = [];
  let step = await script.next();
  while (!step.done) {
    done.push(step.value);
    step = await script.next(step.value.type === "tool" ? shown : "");
  }

  return { done, text: step.value };
}

describe("a decision made with the PM", () => {
  it("asks the PM and holds the round at the gate", async () => {
    const r = await play(assigned(base));
    expect(r.done.slice(1)).toEqual([
      {
        type: "tool",
        tool: "ask",
        input: { to: "pm", question: "What do we pick for the cache size?" },
      },
      { type: "gate", name: DECIDE_GATE },
    ]);
  });

  it("writes the decision with what the requester said, and hands the ticket back", async () => {
    const r = await play(
      assigned({
        ...base,
        answer: "Small.",
        feedback: [{ kind: "chat", body: "Under 64 MB.", threads: [] }],
      }),
    );

    expect(r.done.slice(1)).toEqual([
      {
        type: "tool",
        tool: "ticket_comment",
        input: { key: "SHOP-41", body: "Decided with the PM: Small.\nRequester: Under 64 MB." },
      },
      { type: "tool", tool: "ticket_move", input: { key: "SHOP-41", to: "review" } },
    ]);
  });

  it("has the PM answer a question that is not about the roadmap", async () => {
    const r = await play(
      SCRIPTS["question"]!({
        ...base,
        kind: "question",
        question: { id: "q2", from: "sam", text: "What do we pick for the cache size?" },
      }),
    );

    expect(r.done).toEqual([
      {
        type: "tool",
        tool: "question_answer",
        input: {
          question: "q2",
          answer: "The smallest option that works; we revisit it next milestone.",
        },
      },
    ]);

    await expect(play(SCRIPTS["question"]!(base))).rejects.toThrow("the question");
  });
});

describe("a teammate pinged from chat", () => {
  const chat = {
    ...base,
    kind: "chat",
    title: "Chat with Ada",
    conversation: [{ from: "Ada", agent: false, text: "ping pm: The greetings are live." }],
  };

  it("asks them and replies at once", async () => {
    const script = SCRIPTS["chat"]!(chat);
    const first = await script.next();
    expect(first.value).toEqual({
      type: "tool",
      tool: "ask",
      input: { to: "pm", question: "The greetings are live." },
    });

    const end = await script.next("Asked pia; no answer yet (question q7).");
    expect(end).toEqual({ done: true, value: "Asked pia; I'll pass on the answer here." });
  });

  it("passes the answer on in the round it starts, and only there", async () => {
    const prompt = [
      "Work item c2 (chat): Answer from pia: Chat with Ada",
      "",
      "Journal of earlier rounds:",
      "- 2030-01-01T00:00:00Z office: Answers that arrived while you were working:",
      "- pia on question q7 (The greetings are live.): Noted, thanks.",
    ].join("\n");

    const ctx = parsePrompt(prompt)!;
    expect(ctx.answer).toBe("Noted, thanks.");
    expect((await play(SCRIPTS["chat"]!(ctx))).text).toBe("The answer: Noted, thanks.");
    expect(
      (await play(SCRIPTS["chat"]!({ ...ctx, title: "Chat with Ada", conversation: [] }))).text,
    ).not.toContain("Noted, thanks.");
  });
});
