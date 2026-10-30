import type { ConfiguredPolicy, PipelineEvent, Proposal } from "@outstaff/policy";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { event, OPTS, stateOf } from "#/pipeline/__tests__/support.js";
import type { PipelineOptions } from "#/pipeline/state.types.js";

export { event } from "#/pipeline/__tests__/support.js";

/** A policy on `ticket.assigned` (unless told otherwise) that proposes what it is given. */
export const proposing = (
  id: string,
  proposals: Proposal[],
  o: Partial<ConfiguredPolicy> = {},
): ConfiguredPolicy => ({
  id,
  summary: "test",
  on: ["ticket.assigned", "chat.message", "agent.idle", "pr.comment"],
  decide: () => proposals,
  ...o,
});

export const ON_TICKET = event("ticket.assigned", { subject: { ticket: "ACME-1" } });

/** The trace of the policies on an event. */
export const aggregated = (
  policies: ConfiguredPolicy[],
  e: PipelineEvent = ON_TICKET,
  options: PipelineOptions = OPTS,
) => evaluatePipeline(e, stateOf(), policies, options);

export const wake = (person: string, o: Partial<Extract<Proposal, { type: "wake" }>> = {}) =>
  ({
    type: "wake",
    person,
    kind: "assigned",
    instruction: `Go, ${person}.`,
    reason: "r",
    ...o,
  }) satisfies Proposal;

export const move = (to: "review" | "done", ticket = "ACME-1") =>
  ({ op: "move", ticket, to }) as const;
