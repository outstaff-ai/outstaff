import { describe, expect, it } from "vitest";
import type { UsageTotals } from "@outstaff/protocol";
import { findVerb, runVerb } from "#/verbs/index.js";
import { fakeEnv } from "@outstaff/testing.agent";

const totals = (tokens: number, costUsd: number, runs: number): UsageTotals => ({
  inputTokens: tokens / 4,
  outputTokens: tokens / 4,
  cacheReadTokens: tokens / 4,
  cacheCreationTokens: tokens / 4,
  tokens,
  costUsd,
  runs,
});

describe("usage", () => {
  it("prints the total, the sub-tickets and the breakdowns, and says the cost is API-equivalent", async () => {
    const f = fakeEnv();
    f.office.ticketUsage = async (ticket) => {
      f.office.usageAsked.push(ticket);
      return {
        ticket,
        own: totals(8000, 1.5, 2),
        total: totals(12000, 2.25, 3),
        subTickets: [{ ticket: "ACME-2", total: totals(4000, 0.75, 1) }],
        byPerson: [{ key: "sam", totals: totals(8000, 1.5, 2) }],
        byModel: [{ key: "claude-opus-5-5", totals: totals(8000, 1.5, 2) }],
        byKind: [{ key: "assigned", totals: totals(8000, 1.5, 1) }],
      };
    };

    const r = await runVerb(findVerb("usage")!, f.env, { ticket: "ACME-1" });
    expect(f.office.usageAsked).toEqual(["ACME-1"]);
    expect(r.text.split("\n")).toEqual([
      "ACME-1: 12,000 tokens (input 3,000, output 3,000, cache read 3,000, cache write 3,000), $2.25, 3 runs",
      "Own runs: 8,000 tokens (input 2,000, output 2,000, cache read 2,000, cache write 2,000), $1.50, 2 runs",
      "Sub-tickets:",
      "  ACME-2: 4,000 tokens (input 1,000, output 1,000, cache read 1,000, cache write 1,000), $0.75, 1 run",
      "By person:",
      "  sam: 8,000 tokens (input 2,000, output 2,000, cache read 2,000, cache write 2,000), $1.50, 2 runs",
      "By model:",
      "  claude-opus-5-5: 8,000 tokens (input 2,000, output 2,000, cache read 2,000, cache write 2,000), $1.50, 2 runs",
      "By kind of round:",
      "  assigned: 8,000 tokens (input 2,000, output 2,000, cache read 2,000, cache write 2,000), $1.50, 1 run",
      "",
      "The cost is API-equivalent: what the tokens cost at API list prices, not what a subscription bills. Tokens are exact.",
    ]);
  });

  it("prints only the total for a ticket nothing was used on", async () => {
    const f = fakeEnv();
    const r = await runVerb(findVerb("usage")!, f.env, { ticket: "ACME-9" });
    expect(r.text.split("\n")[0]).toBe(
      "ACME-9: 0 tokens (input 0, output 0, cache read 0, cache write 0), $0.00, 0 runs",
    );

    expect(r.text).not.toContain("By person");
  });
});
