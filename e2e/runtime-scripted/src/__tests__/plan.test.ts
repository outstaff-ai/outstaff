import { describe, expect, it } from "vitest";
import { PLAN_MILESTONE, PLAN_TICKETS } from "#/plan.js";
import { assigned, chat, type Action } from "#/scripts.js";

const base = {
  itemId: "c9",
  kind: "chat",
  title: "chat: re-plan",
  journal: "",
  feedback: [],
  conventionFiles: [],
};

/** Plays a script, answering each tool call by its name, and returns the calls and the final message. */
async function play(
  script: AsyncGenerator<Action, string, string>,
  answers: Record<string, string>,
) {
  const tools: { tool: string; input: Record<string, unknown> }[] = [];
  let step = await script.next();
  while (!step.done) {
    const a = step.value;
    if (a.type === "tool") {
      tools.push({ tool: a.tool, input: a.input });
    }

    step = await script.next(a.type === "tool" ? (answers[a.tool] ?? "") : "");
  }

  return { tools, text: step.value };
}

const ask = { from: "ada", agent: false, text: "The checkout tickets need better planning." };

describe("planning in chat", () => {
  it("answers a request to re-plan with a proposal and files nothing", async () => {
    const r = await play(chat({ ...base, conversation: [ask] }), {});
    expect(r.tools.map((t) => t.tool)).toEqual(["milestone_list"]);
    expect(r.text).toBe(
      `Proposal: milestone "${PLAN_MILESTONE}" with "${PLAN_TICKETS[0]}" and "${PLAN_TICKETS[1]}". Shall I file it?`,
    );
  });

  it("files the milestone and its tickets once the human confirms", async () => {
    const proposal = (await play(chat({ ...base, conversation: [ask] }), {})).text;
    const r = await play(
      chat({
        ...base,
        conversation: [
          ask,
          { from: "pia", agent: true, text: proposal },
          { from: "ada", agent: false, text: "Yes, go ahead." },
        ],
      }),
      { milestone_create: "Created milestone 12.\n- 12 [planned] Checkout cleanup: ..." },
    );

    expect(r.tools).toEqual([
      { tool: "milestone_create", input: { title: PLAN_MILESTONE } },
      ...PLAN_TICKETS.map((title) => ({
        tool: "ticket_create",
        input: {
          title,
          body: `Part of the ${PLAN_MILESTONE} plan.`,
          milestone: "12",
          assignee: "me",
          status: "backlog",
        },
      })),
    ]);
  });

  it("hands every ticket of the PM's one round to review", async () => {
    const r = await play(
      assigned({
        ...base,
        kind: "assigned",
        ticket: "SHOP-50",
        journal:
          "- office: The chat session also filed SHOP-51 Show the order summary for this request.",
      }),
      {},
    );

    expect(r.tools).toEqual([
      { tool: "ticket_move", input: { key: "SHOP-50", to: "review" } },
      { tool: "ticket_move", input: { key: "SHOP-51", to: "review" } },
    ]);
  });
});
