import { describe, expect, it } from "vitest";
import type { WorkItem } from "#/store/index.js";
import { blockedAgent, CLOCK_SKEW_MS, inRound, ticketWork } from "#/workstate/blocked.js";
import type { TicketWork } from "#/workstate/core.types.js";
import type { TicketRecord } from "#/workstate/types.js";

const at = (minute: number) => `2026-10-05T09:${String(minute).padStart(2, "0")}:00.000Z`;

const work = (
  person: string,
  status: TicketWork["status"],
  from: number,
  to: number,
  kind = "assigned",
): TicketWork => ({ person, kind, status, from: at(from), to: at(to) });

const ticket = (status: NonNullable<TicketRecord["status"]>, since?: number): TicketRecord => ({
  key: "ACME-1",
  title: "Rotate the key",
  status,
  ...(since === undefined ? {} : { statusSince: at(since) }),
  labels: [],
  updatedAt: at(0),
});

describe("the agent blocked on a ticket", () => {
  it("is the agent whose latest work was handed back as blocked, while the ticket is blocked", () => {
    const sam = work("sam", "blocked", 0, 10);
    expect(blockedAgent(ticket("blocked", 11), [sam])).toBe("sam");
    expect(blockedAgent(ticket("active", 11), [sam])).toBeUndefined();
    expect(blockedAgent(undefined, [sam])).toBeUndefined();
    expect(blockedAgent(ticket("blocked", 11), [])).toBeUndefined();
  });

  it("is the agent who moved the ticket to blocked during its work and handed it back as done", () => {
    const sam = work("sam", "done", 0, 10);
    expect(blockedAgent(ticket("blocked", 5), [sam])).toBe("sam");
    expect(blockedAgent(ticket("blocked", 10), [sam])).toBe("sam");
    // Someone else blocked the ticket after the agent finished: the agent is not blocked on it.
    expect(blockedAgent(ticket("blocked", 12), [sam])).toBeUndefined();
    expect(blockedAgent(ticket("blocked"), [sam])).toBeUndefined();
  });

  it("is unchanged by an unblock round, an answered question or another agent's round", () => {
    const rounds = [
      work("sam", "blocked", 0, 10),
      work("pia", "done", 11, 20, "unblock"),
      work("mira", "done", 12, 21, "asked"),
      work("noor", "done", 22, 30, "ticket_comment"),
    ];

    expect(blockedAgent(ticket("blocked", 11), rounds)).toBe("sam");
  });

  it("is cleared when the agent works on the ticket again", () => {
    const rounds = [work("sam", "blocked", 0, 10), work("sam", "active", 20, 20, "ticket_comment")];
    expect(blockedAgent(ticket("blocked", 11), rounds)).toBeUndefined();
    expect(blockedAgent(ticket("blocked", 11), rounds.toReversed())).toBeUndefined();
  });

  it("is the latest of the agents blocked on it", () => {
    const rounds = [work("sam", "blocked", 0, 10), work("noor", "blocked", 11, 20)];
    expect(blockedAgent(ticket("blocked", 21), rounds)).toBe("noor");
    expect(blockedAgent(ticket("blocked", 21), rounds.toReversed())).toBe("noor");
  });
});

describe("an agent's round on a ticket", () => {
  it("spans from when the item was queued until it ended, or until now while it runs", () => {
    const rounds = [work("pia", "done", 10, 20, "unblock"), work("sam", "active", 30, 30)];
    expect(inRound(rounds, "pia", at(10))).toBe(true);
    expect(inRound(rounds, "pia", at(20))).toBe(true);
    expect(inRound(rounds, "pia", at(21))).toBe(false);
    expect(inRound(rounds, "pia", at(9))).toBe(false);
    expect(inRound(rounds, "sam", at(59))).toBe(true);
    expect(inRound(rounds, "sam", at(29))).toBe(false);
    expect(inRound(rounds, "noor", at(15))).toBe(false);
  });

  it("takes a tracker time a little off the office's clock as the round's own", () => {
    const rounds = [work("pia", "done", 10, 10, "unblock")];
    const off = (ms: number) => new Date(Date.parse(at(10)) + ms).toISOString();
    expect(inRound(rounds, "pia", off(CLOCK_SKEW_MS))).toBe(true);
    expect(inRound(rounds, "pia", off(-CLOCK_SKEW_MS))).toBe(true);
    expect(inRound(rounds, "pia", off(CLOCK_SKEW_MS + 1))).toBe(false);
    expect(inRound(rounds, "pia", off(-CLOCK_SKEW_MS - 1))).toBe(false);
  });

  it("is read from an item once it was offered", () => {
    const item = {
      person: "sam",
      kind: "assigned",
      status: "queued",
      createdAt: at(0),
      updatedAt: at(1),
    } as WorkItem;

    expect(ticketWork(item)).toBeUndefined();
    expect(ticketWork({ ...item, status: "blocked" })).toEqual(work("sam", "blocked", 0, 1));
  });
});
