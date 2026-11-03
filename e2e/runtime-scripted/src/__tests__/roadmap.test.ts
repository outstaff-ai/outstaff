import { describe, expect, it } from "vitest";
import { parsePrompt } from "#/prompt.js";
import { milestoneDone, placeFeature, PLAN_PATH, startMilestone } from "#/roadmap.js";
import { assigned, chat, type Action } from "#/scripts.js";

const base = {
  itemId: "w9",
  kind: "ticket",
  title: "ticket: SHOP-40 Plan: resource monitoring",
  ticket: "SHOP-40",
  worktree: "/wt",
  repo: "shop",
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

describe("the roadmap scripts", () => {
  it("files one ticket to plan a feature asked for in chat", async () => {
    const r = await play(
      chat({
        ...base,
        kind: "chat",
        conversation: [{ from: "ada", agent: false, text: "Feature: monitoring" }],
      }),
      {},
    );

    expect(r.tools).toEqual([
      { tool: "ticket_create", input: { title: "Plan: monitoring", body: "monitoring" } },
    ]);
  });

  it("writes the plan and asks the PM, then says where the PM placed it", async () => {
    const shown = "SHOP-40: Plan: resource monitoring\nStatus: In Progress";
    const asked = await play(assigned(base), {
      ticket_show: shown,
      doc_create: "Created.\nhttps://kb.acme.example/docs/12",
    });

    expect(asked.tools.map((t) => t.tool)).toEqual(["ticket_show", "doc_create", "ask"]);
    expect(asked.tools[2]!.input).toEqual({
      to: "pm",
      question: `Where does SHOP-40 fit on the roadmap? Its plan: ${PLAN_PATH} (https://kb.acme.example/docs/12).`,
    });

    const placed = await play(assigned({ ...base, answer: "Later: milestone Monitoring (8)." }), {
      ticket_show: shown,
    });

    expect(placed.tools.map((t) => t.tool)).toEqual([
      "ticket_show",
      "ticket_comment",
      "ticket_move",
    ]);
  });

  it("places the feature in the planned milestone and answers the question", async () => {
    const r = await play(
      placeFeature({
        ...base,
        kind: "question",
        question: {
          id: "q1",
          from: "sam",
          text: `Where does SHOP-40 fit? Its plan: ${PLAN_PATH} (x).`,
        },
      }),
      { milestone_list: "- 8 [planned] Monitoring: https://t.acme.example/initiative/8" },
    );

    expect(r.tools.slice(1)).toEqual([
      { tool: "milestone_add", input: { id: "8", doc: PLAN_PATH } },
      {
        tool: "question_answer",
        input: {
          question: "q1",
          answer: "Later: milestone Monitoring (8), after Foundations. Its plan is linked there.",
        },
      },
    ]);
  });

  it("closes a finished milestone and proposes the next, then starts it with the tickets that can start now", async () => {
    const done = await play(
      milestoneDone({ ...base, kind: "milestone", milestone: { id: "7", title: "Foundations" } }),
      {
        milestone_list: "- 8 [planned] Monitoring: https://t.acme.example/initiative/8",
        doc_create: "Created Roadmap.\nhttps://kb.acme.example/docs/13",
      },
    );

    expect(done.tools.map((t) => t.tool)).toEqual([
      "milestone_show",
      "milestone_status",
      "milestone_list",
      "doc_create",
      "ticket_comment",
    ]);

    const started = await play(startMilestone(base, "13", "c1", "Monitoring"), {
      milestone_list: "- 7 [done] Foundations: u\n- 8 [planned] Monitoring: u",
      milestone_show:
        "8: Monitoring\n\nDocuments:\n- Plan: monitoring: https://kb.acme.example/docs/12",
      doc_show:
        "Plan\nhttps://kb.acme.example/docs/12\n\n- now: Collect metrics\n- after the dashboard: Show history",
      ticket_create: "Created SHOP-41.",
    });

    expect(started.tools.filter((t) => t.tool === "ticket_create")).toEqual([
      {
        tool: "ticket_create",
        input: {
          title: "Collect metrics",
          body: "From the plan https://kb.acme.example/docs/12.",
          milestone: "8",
        },
      },
    ]);

    expect(started.text).toContain("filed SHOP-41");
  });

  it("reads a question, an answer and a milestone wake from the prompt", () => {
    const prompt = [
      "Work item w9 (question): Question from sam: Where?",
      "Journal of earlier rounds:",
      "- 2026-11-03T10:00:00Z sam: Question q1 from sam (developer):",
      "Where does SHOP-40 fit?",
      "- 2026-11-03T10:01:00Z office: pia answered question q1 (Where does SHOP-40 fit? (x)):",
      "Later.",
      'SHOP-3 was closed as done, and it was the last open ticket of milestone "Foundations" (7) that the office knows.',
    ].join("\n");

    expect(parsePrompt(prompt)).toMatchObject({
      question: { id: "q1", from: "sam", text: "Where does SHOP-40 fit?" },
      answer: "Later.",
      milestone: { id: "7", title: "Foundations" },
    });
  });
});
