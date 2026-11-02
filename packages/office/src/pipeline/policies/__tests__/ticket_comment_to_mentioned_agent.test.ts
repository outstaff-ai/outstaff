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
          "sam mentioned you in a comment on ACME-1. Read the comment and answer it, or do what it asks, on the ticket. The ticket stays with its assignee: leave its assignee and status as they are, unless the comment asks you to take the ticket over.",
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

  it("wakes no one for an automation's comment or on a closed ticket", () => {
    expect(judge(ID, comment(OFFICE, { mentions: ["mira"] }), world)).toEqual({
      failed: { not: { actor_kind: "automation" } },
    });

    expect(
      judge(ID, comment(SAM, { mentions: ["mira"] }), { tickets: { "ACME-1": t("done", "sam") } }),
    ).toMatchObject({ failed: { not: expect.anything() } });
  });
});
