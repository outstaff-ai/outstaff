import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, OFFICE, SAM, event, judge, t, traceOf, type World } from "./support.js";

const MIRA = { kind: "agent" as const, id: "mira" };
const ID = "ticket_comment_to_mentioned_agent";

const comment = (actor: PipelineEvent["actor"], data: Record<string, unknown> = {}) =>
  event("ticket.commented", {
    subject: { ticket: "ACME-1" },
    actor,
    data: { body: "Please fold this into the device service work.", ...data },
  });

/** Every wake the comment makes, of every policy. */
const wakes = (e: PipelineEvent, world: World) =>
  traceOf(e, world).decisions.flatMap((d) =>
    d.type === "wake" ? [`${d.policy}: wake ${d.person} (${d.kind})`] : [],
  );

describe("ticket_comment_to_mentioned_agent", () => {
  const world: World = { tickets: { "ACME-1": t("active", "sam") } };

  it("an agent's or a human's comment wakes the agent it mentions first, to answer without taking the ticket", () => {
    expect(judge(ID, comment(SAM, { mentions: ["mira", "leo"] }), world)).toEqual([
      "wake mira (asked) on ticket ACME-1",
    ]);

    expect(traceOf(comment(SAM, { mentions: ["mira"] }), world).decisions).toMatchObject([
      {
        type: "wake",
        person: "mira",
        kind: "asked",
        instruction:
          "sam mentioned you in a comment on ACME-1. Read the comment and judge first whether anything in it is for you: a question you can answer, or an action that is yours. If something is, answer it, or do what it asks, on the ticket, once. A teammate's mention starts no new work: when an agent mentioned you, file no ticket and open no pull request for it (both are refused); propose the work to a trusted human on the ticket instead. If nothing is, end the round silently: no comment and no message; finish with `ost handback silent` and a one-line journal note. Never restate what someone else already said or asked. The ticket stays with its assignee: leave its assignee and status as they are, unless the comment asks you to take the ticket over. ACME-1's status now: active. A done or canceled ticket stays closed unless the comment asks to reopen it.",
      },
    ]);

    // One wake per comment: a human's mention, even of the assignee, is this policy's alone.
    for (const mentioned of ["mira", "sam"]) {
      expect(wakes(comment(ADA, { mentions: [mentioned] }), world)).toEqual([
        `${ID}: wake ${mentioned} (asked)`,
      ]);
    }
  });

  it("an agent's comment that mentions no other agent wakes no one", () => {
    expect(judge(ID, comment(SAM), world)).toEqual({ failed: { agent_mentioned: true } });
    expect(wakes(comment(SAM), world)).toEqual([]);
    expect(wakes(comment(MIRA), { tickets: { "ACME-1": t("review", "ada.admin") } })).toEqual([]);
  });

  it("wakes no one for an automation's comment, or for an agent's on a closed ticket", () => {
    expect(judge(ID, comment(OFFICE, { mentions: ["mira"] }), world)).toEqual({
      failed: { not: { actor_kind: "automation" } },
    });

    expect(
      judge(ID, comment(SAM, { mentions: ["mira"] }), { tickets: { "ACME-1": t("done", "sam") } }),
    ).toMatchObject({ failed: { any: expect.anything() } });
  });

  it("a human's mention wakes the agent on a ticket closed long before, saying it is closed", () => {
    const closed: World = {
      tickets: {
        "ACME-1": t("done", "ada.admin", {
          statusSince: "2026-09-01T09:00:00.000Z",
          previousStatus: "review",
        }),
      },
    };

    const late = comment(ADA, { mentions: ["mira"], at: "2026-10-05T09:00:00.000Z" });
    expect(wakes(late, closed)).toEqual([`${ID}: wake mira (asked)`]);
    expect(traceOf(late, closed).decisions[0]).toMatchObject({
      instruction: expect.stringContaining(
        "ACME-1's status now: done. A done or canceled ticket stays closed unless the comment asks to reopen it.",
      ),
    });

    // Without a mention, a comment after the close wakes no one.
    expect(wakes(comment(ADA, { at: "2026-10-05T09:00:00.000Z" }), closed)).toEqual([]);
  });

  it("judges a comment by the status when it was written: one just before the close was on an open ticket", () => {
    const closing: World = {
      tickets: {
        "ACME-1": t("done", "sam", {
          statusSince: "2026-10-05T09:00:07.000Z",
          previousStatus: "active",
        }),
      },
    };

    // An agent's mention, written seconds before a human closed the ticket, still wakes the agent it mentions.
    const before = comment(SAM, { mentions: ["mira"], at: "2026-10-05T09:00:00.000Z" });
    expect(wakes(before, closing)).toEqual([`${ID}: wake mira (asked)`]);
    expect(traceOf(before, closing).policies.find((p) => p.policy === ID)?.reason).toBe(
      "all conditions hold",
    );

    expect(
      traceOf(
        comment(SAM, { mentions: ["mira"], at: "2026-10-05T09:00:08.000Z" }),
        closing,
      ).policies.find((p) => p.policy === ID),
    ).toMatchObject({
      matched: false,
      reason: "none of: actor is agent, wanted human; not (ticket status done in [done, canceled])",
    });

    // A human's comment without a mention goes to the assignee, as on any open ticket.
    expect(wakes(comment(ADA, { at: "2026-10-05T09:00:00.000Z" }), closing)).toEqual([
      "ticket_comment_to_agent: wake sam (ticket_comment)",
    ]);
  });
});
