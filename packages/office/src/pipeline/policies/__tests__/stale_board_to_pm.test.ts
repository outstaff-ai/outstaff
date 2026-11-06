import { describe, expect, it } from "vitest";
import { event, judge, t, traceOf, type World } from "./support.js";

const WORKSTATE = { kind: "automation" as const, id: "workstate" };

const stale = (tickets: unknown) =>
  event("board.stale", { subject: { ticket: "ACME-3" }, actor: WORKSTATE, data: { tickets } });

const world: World = { tickets: { "ACME-3": t("review", "ada-admin") }, roles: { pm: "priya" } };

describe("stale_board_to_pm", () => {
  it("wakes the PM once, with each ticket and its facts", () => {
    const found = stale([
      {
        ticket: "ACME-3",
        status: "review",
        assignee: "ada-admin",
        reason: "prs_finished",
        facts: "its pull requests are all merged or closed: #9 merged",
      },
      { ticket: "ACME-4", status: "active", reason: "stranded", facts: "nobody works on it" },
      { status: "blocked" },
    ]);

    expect(judge("stale_board_to_pm", found, world)).toEqual([
      "wake priya (reconcile) on ticket ACME-3",
    ]);

    const [wake] = traceOf(found, world).decisions;
    expect((wake as { instruction: string }).instruction).toContain(
      "- ACME-3 (review, with ada-admin): its pull requests are all merged or closed: #9 merged\n- ACME-4 (active): nobody works on it\nFor each,",
    );
  });

  it("wakes no one for a sweep that found nothing, and renders no line for an entry it cannot read", () => {
    expect(judge("stale_board_to_pm", stale([]), world)).toEqual([
      "drop: the sweep found no ticket out of step",
    ]);

    const quiet = event("board.stale", { subject: {}, actor: WORKSTATE, data: { tickets: [] } });
    expect(traceOf(quiet, world).decisions).toEqual([
      expect.objectContaining({ type: "drop", policy: "stale_board_to_pm" }),
    ]);

    expect(judge("stale_board_to_pm", stale("not a list"), world)).toEqual([
      "drop: the sweep found no ticket out of step",
    ]);

    const [wake] = traceOf(stale([{ status: "blocked" }]), world).decisions;
    expect((wake as { instruction: string }).instruction).toContain("knows:\n\nFor each");
  });
});
