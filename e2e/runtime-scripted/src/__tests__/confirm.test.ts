import { describe, expect, it } from "vitest";
import { BUILD_TICKETS } from "#/confirm.js";
import { assigned, ticketComment, type Action } from "#/scripts.js";

const base = { itemId: "w9", journal: "", feedback: [], conventionFiles: [] };

/** Plays a script, answering each tool call by its name, and returns the calls and the final message. */
async function play(
  script: AsyncGenerator<Action, string, string>,
  answers: Record<string, string | (() => string)>,
) {
  const tools: { tool: string; input: Record<string, unknown> }[] = [];
  let step = await script.next();
  while (!step.done) {
    const a = step.value;
    if (a.type === "tool") {
      tools.push({ tool: a.tool, input: a.input });
    }

    const answer = a.type === "tool" ? answers[a.tool] : undefined;
    step = await script.next(typeof answer === "function" ? answer() : (answer ?? ""));
  }

  return { tools, text: step.value };
}

describe("the PM waiting on the human's word on a design ticket", () => {
  it("asks the human on the design ticket, mentioning them, and hands the parent back blocked", async () => {
    const r = await play(
      assigned({
        ...base,
        kind: "assigned",
        title: "assigned: SHOP-60 Gift cards",
        ticket: "SHOP-60",
      }),
      { ticket_show: "SHOP-60: Gift cards\nconfirm design: SHOP-61\n" },
    );

    expect(r.tools).toEqual([
      { tool: "ticket_show", input: { key: "SHOP-60" } },
      {
        tool: "ticket_comment",
        input: {
          key: "SHOP-61",
          body: "@ada-admin please confirm that revision; then I split SHOP-60 into build tickets.",
        },
      },
      { tool: "ticket_move", input: { key: "SHOP-60", to: "blocked" } },
      {
        tool: "ticket_comment",
        input: {
          key: "SHOP-60",
          body: "Blocked: waiting for ada-admin to confirm the design on SHOP-61.",
        },
      },
      {
        tool: "handback",
        input: {
          status: "blocked",
          message: "SHOP-60 needs ada-admin to confirm the design on SHOP-61.",
        },
      },
    ]);

    expect(r.text).toBe("Asked ada-admin to confirm the design on SHOP-61.");
  });

  it("splits the parent into build tickets when the human answers there", async () => {
    let n = 70;
    const r = await play(
      ticketComment({
        ...base,
        kind: "ticket_comment",
        title: "ticket comment: SHOP-61 Design the gift card page",
        ticket: "SHOP-61",
        answersAsker: true,
        feedback: [
          { kind: "ticket_comment", body: "All good, let's build with this version.", threads: [] },
        ],
      }),
      {
        ticket_show:
          "SHOP-61: Design the gift card page\nComments (1):\n- Pia Novak: @ada-admin please confirm that revision; then I split [SHOP-60](http://t.example/SHOP-60) into build tickets. (http://t.example/SHOP-61#c1)",
        ticket_create: () => `Created SHOP-${n++}.`,
      },
    );

    expect(r.tools).toEqual([
      { tool: "ticket_show", input: { key: "SHOP-61" } },
      ...BUILD_TICKETS.map((title) => ({
        tool: "ticket_create",
        input: {
          title,
          body: "Built to the design confirmed on SHOP-61.",
          parent: "SHOP-60",
          status: "backlog",
        },
      })),
      {
        tool: "ticket_comment",
        input: {
          key: "SHOP-60",
          body: "Split into SHOP-70 and SHOP-71: the design on SHOP-61 is confirmed.",
        },
      },
      { tool: "handback", input: { status: "silent" } },
    ]);

    expect(r.text).toBe("Split SHOP-60 into SHOP-70, SHOP-71.");
  });

  it("fails loudly when the design ticket names no parent to split", async () => {
    await expect(
      play(
        ticketComment({
          ...base,
          kind: "ticket_comment",
          title: "ticket comment: SHOP-61 Design",
          ticket: "SHOP-61",
          answersAsker: true,
          feedback: [{ kind: "ticket_comment", body: "Yes.", threads: [] }],
        }),
        { ticket_show: "SHOP-61: Design" },
      ),
    ).rejects.toThrow("w9: no parent to split is named on SHOP-61.");
  });
});
