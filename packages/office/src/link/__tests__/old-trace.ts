import type { Trace } from "#/pipeline/trace.types.js";

/**
 * A trace as an office recorded it before policies proposed and the aggregation decided: each policy kept its own
 * `decisions`, and the trace had the engine's name and comparison but no aggregation.
 */
export const OLD_TRACE = {
  event: {
    id: "vcs:acme/app#7:merged",
    type: "pr.merged",
    at: "2026-09-20T10:00:00.000Z",
    subject: {
      ticket: "ACME-7",
      pr: { repo: { host: "github.com", owner: "acme", name: "app" }, number: 7 },
    },
    actor: { kind: "human", id: "sam" },
    data: {
      headRef: "ada/acme-7-cart",
      headSha: "0a1b2c3",
      baseRef: "main",
      at: "2026-09-20T10:00:00Z",
    },
  },
  policies: [
    {
      policy: "opened_to_review",
      matched: false,
      decisions: [],
      reason: "listens to pr.opened, not pr.merged",
    },
    {
      policy: "merged_closes_ticket",
      matched: false,
      decisions: [],
      reason: "ticket status done in [active, review]",
      failed: { ticket_status: ["active", "review"] },
    },
  ],
  decisions: [{ type: "drop", reason: "no policy matched" }],
  engine: { effects: [] },
  comparison: { agree: true, differences: [] },
} as unknown as Trace;
