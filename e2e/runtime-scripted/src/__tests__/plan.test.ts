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
          status: "ready",
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

describe("starting the next milestone from chat", () => {
  const start = { from: "ada", agent: false, text: "Start the next milestone." };

  it("starts the first planned milestone itself and says so", async () => {
    const r = await play(chat({ ...base, conversation: [start] }), {
      milestone_list:
        "- 12 [planned] Checkout cleanup: https://plan.example/i/12\n- 13 [planned] Payments: https://plan.example/i/13",
    });

    expect(r.tools).toEqual([
      { tool: "milestone_list", input: { status: ["planned"] } },
      { tool: "milestone_status", input: { id: "12", to: "active" } },
    ]);

    expect(r.text).toBe("Started Checkout cleanup (12).");
  });

  it("says so when no milestone is planned", async () => {
    const r = await play(chat({ ...base, conversation: [start] }), {
      milestone_list: "No milestones.",
    });

    expect(r.tools.map((t) => t.tool)).toEqual(["milestone_list"]);
    expect(r.text).toBe("There is no planned milestone to start.");
  });
});

describe("a request for later in chat", () => {
  const later = {
    from: "ada",
    agent: false,
    text: "File a backlog ticket for the invoice export.",
  };

  it("files it in the backlog and nothing more, and says so", async () => {
    const r = await play(chat({ ...base, conversation: [later] }), {
      ticket_create: "Created SHOP-7.\nFiled in the backlog for later.",
    });

    expect(r.tools).toEqual([
      {
        tool: "ticket_create",
        input: {
          title: "the invoice export",
          body: "Asked in chat, for later.",
          status: "backlog",
        },
      },
    ]);

    expect(r.text).toBe(
      "Filed SHOP-7 in the backlog for later: nothing starts it until you move it on.",
    );
  });

  it("names no key the filing did not give", async () => {
    const r = await play(chat({ ...base, conversation: [later] }), {});
    expect(r.text).toContain("Filed the ticket in the backlog");
  });
});
