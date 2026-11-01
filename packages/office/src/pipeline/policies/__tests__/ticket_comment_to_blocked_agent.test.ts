import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describe, expect, it } from "vitest";
import { ADA, OFFICE, SAM, event, judge, t, traceOf, type World } from "./support.js";

const MIRA = { kind: "agent" as const, id: "mira" };
const AT = "2026-10-05T09:00:00.000Z";

/** ACME-1, blocked on sam, with the human, and the rounds the agents had on it. */
const blocked = (assignee = "ada.admin", extra: Partial<StaticTicket> = {}): World => ({
  tickets: {
    "ACME-1": t("blocked", assignee, {
      blockedAgent: "sam",
      lastWorker: "sam",
      rounds: [
        { person: "mira", from: "2026-10-05T08:00:00.000Z", to: "2026-10-05T08:30:00.000Z" },
      ],
      ...extra,
    }),
  },
});

const comment = (actor: PipelineEvent["actor"] = MIRA, data: Record<string, unknown> = {}) =>
  event("ticket.commented", {
    subject: { ticket: "ACME-1" },
    actor,
    data: { body: "The answer: friendly.", at: AT, ...data },
  });

/** Every wake the comment makes, of every policy: a comment wakes one agent at most. */
const decisions = (e: PipelineEvent, world: World) =>
  traceOf(e, world).decisions.flatMap((d) =>
    d.type === "wake" ? [`${d.policy}: ${d.type} ${d.person}`] : [],
  );

describe("ticket_comment_to_blocked_agent", () => {
  it("an agent's answer on a blocked ticket wakes the agent blocked on it, and no one else", () => {
    expect(decisions(comment(), blocked())).toEqual(["ticket_comment_to_blocked_agent: wake sam"]);

    expect(traceOf(comment(), blocked()).decisions).toMatchObject([
      {
        type: "wake",
        kind: "ticket_comment",
        instruction:
          "mira commented on ACME-1, which you handed back as blocked. Read the comment. If it unblocks the work, assign the ticket to yourself, move it to active and continue. Otherwise answer on the ticket what is still missing.",
      },
    ]);
  });

  it("a human's comment wakes the blocked agent, not the last worker as well", () => {
    expect(decisions(comment(ADA), blocked())).toEqual([
      "ticket_comment_to_blocked_agent: wake sam",
    ]);

    expect(decisions(comment(ADA), blocked("ada.admin", { lastWorker: "mira" }))).toEqual([
      "ticket_comment_to_blocked_agent: wake sam",
    ]);
  });

  it("a human's mention wakes the agent mentioned, through ticket_comment_to_agent alone", () => {
    for (const mentioned of ["sam", "mira"]) {
      expect(decisions(comment(ADA, { mentions: [mentioned] }), blocked())).toEqual([
        `ticket_comment_to_agent: wake ${mentioned}`,
      ]);
    }
  });

  it("a comment on a ticket with an agent wakes that agent if a human made it, else no one", () => {
    expect(decisions(comment(ADA), blocked("mira"))).toEqual([
      "ticket_comment_to_agent: wake mira",
    ]);

    expect(decisions(comment(), blocked("mira"))).toEqual([]);
    expect(judge("ticket_comment_to_blocked_agent", comment(), blocked("mira"))).toEqual({
      failed: { not: { assignee_kind: "agent" } },
    });
  });

  it("wakes no one for the blocked agent's own comment, a round's own comment or the office's", () => {
    const judged = (e: PipelineEvent, world = blocked()) =>
      judge("ticket_comment_to_blocked_agent", e, world);

    expect(judged(comment(SAM))).toEqual({ failed: { not: { actor_is: "blocked_agent" } } });
    expect(judged(comment(OFFICE))).toEqual({ failed: { not: { actor_kind: "automation" } } });
    expect(judged(comment(MIRA, { at: "2026-10-05T08:10:00.000Z" }))).toEqual({
      failed: { not: { actor_in_round: true } },
    });

    expect(
      judged(comment(), blocked("ada.admin", { rounds: [{ person: "mira", from: AT }] })),
    ).toEqual({ failed: { not: { actor_in_round: true } } });

    expect(decisions(comment(SAM), blocked())).toEqual([]);

    // An agent's comment without a time wakes no one: a missed wake can be recovered, a wake loop cannot.
    const untimed = event("ticket.commented", {
      subject: { ticket: "ACME-1" },
      actor: MIRA,
      data: { body: "The answer: friendly." },
    });

    expect(judged(untimed)).toEqual({ failed: { not: { actor_in_round: true } } });
    expect(decisions(untimed, blocked())).toEqual([]);
  });

  it("does nothing when no agent is blocked on the ticket", () => {
    const judged = (world: World) => judge("ticket_comment_to_blocked_agent", comment(), world);
    expect(
      judged({ tickets: { "ACME-1": t("blocked", "ada.admin", { lastWorker: "sam" }) } }),
    ).toEqual({ failed: { blocked_agent: true } });

    expect(decisions(comment(), { tickets: { "ACME-1": t("review", "ada.admin") } })).toEqual([]);
    expect(decisions(comment(), { tickets: { "ACME-1": t("active", "sam") } })).toEqual([]);
    // A human's comment on a ticket blocked with no agent blocked on it still reaches the last worker.
    expect(
      decisions(comment(ADA), {
        tickets: { "ACME-1": t("blocked", "ada.admin", { lastWorker: "sam" }) },
      }),
    ).toEqual(["ticket_comment_to_last_worker: wake sam"]);
  });
});
