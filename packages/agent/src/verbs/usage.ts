import type { TicketUsage, UsageTotals } from "@outstaff/protocol";
import { z } from "zod";
import { defineVerb, result } from "./define.js";
import { requireOffice } from "./support.js";

const NOTE =
  "The cost is API-equivalent: what the tokens cost at API list prices, not what a subscription bills. Tokens are exact.";

const tokens = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(2)}`;
const runs = (n: number) => `${n} run${n === 1 ? "" : "s"}`;

/** One line of totals: tokens with their split, cost and runs. */
const line = (t: UsageTotals) =>
  `${tokens(t.tokens)} tokens (input ${tokens(t.inputTokens)}, output ${tokens(t.outputTokens)}, cache read ${tokens(t.cacheReadTokens)}, cache write ${tokens(t.cacheCreationTokens)}), ${usd(t.costUsd)}, ${runs(t.runs)}`;

const section = (title: string, groups: TicketUsage["byPerson"]) =>
  groups.length === 0 ? [] : [title, ...groups.map((g) => `  ${g.key}: ${line(g.totals)}`)];

const subTickets = (u: TicketUsage) =>
  u.subTickets.length === 0
    ? []
    : [
        `Own runs: ${line(u.own)}`,
        "Sub-tickets:",
        ...u.subTickets.map((s) => `  ${s.ticket}: ${line(s.total)}`),
      ];

/** The ticket's usage as text: totals, sub-tickets, then its own runs by person, model and kind of round. */
export function usageText(u: TicketUsage): string[] {
  return [
    `${u.ticket}: ${line(u.total)}`,
    ...subTickets(u),
    ...section("By person:", u.byPerson),
    ...section("By model:", u.byModel),
    ...section("By kind of round:", u.byKind),
    "",
    NOTE,
  ];
}

export const usage = defineVerb({
  name: "usage",
  summary: "Show the tokens and cost of a ticket's agent work, by person, model and kind of round.",
  description:
    "Prints what agents used on a ticket, as the office totals it: every run of every work item whose subject or references name the ticket (its rounds, review and merge rounds of its pull requests, comment rounds and chat sessions attached to it), broken down by person, model and kind of round, and the total with its sub-tickets rolled up. The cost is API-equivalent (API list prices), not what a subscription bills.",
  input: z.strictObject({
    ticket: z.string().min(1).max(100).describe("Key of the ticket, for example ACME-123."),
  }),
  args: ["ticket"],
  examples: ["ost usage ACME-123"],
  async run(env, input) {
    const u = await requireOffice(env).ticketUsage(input.ticket);
    return result(usageText(u), u, []);
  },
});
