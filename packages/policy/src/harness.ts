import { createStaticWorkflowState } from "@outstaff/core";
import type { PipelineEvent, PipelineEventType } from "./events.types.js";
import type { HarnessResult, HarnessStep, HarnessWorld } from "./harness.types.js";
import type { ConfiguredPolicy, PolicyOptions, PolicyState } from "./policy.types.js";
import type { ErrorProposal, Proposal } from "./proposal.types.js";
import { runPolicy } from "./run.js";

/** The state a step's world describes: the office's static work state plus the agents' ready tickets. */
export const harnessState = (world: HarnessWorld = {}): PolicyState => ({
  ...createStaticWorkflowState(world),
  readyTickets: (person) => world.ready?.[person] ?? [],
});

/** An event for a test: a human's, now-ish, with nothing in it unless told otherwise. */
export function harnessEvent(
  type: PipelineEventType,
  o: Partial<Omit<PipelineEvent, "type">> = {},
): PipelineEvent {
  return {
    id: `test:${type}`,
    type,
    at: "2026-01-05T09:00:00.000Z",
    subject: {},
    actor: { kind: "human", id: "ada-admin" },
    data: {},
    ...o,
  };
}

/**
 * Replays recorded events through one policy, the way the office's bus runs it, and returns what it proposed for each:
 * nothing for an event it does not listen to or whose `when` fails. Pure; snapshot the result with `formatReplay`.
 */
export function replayPolicy(
  policy: ConfiguredPolicy,
  steps: readonly HarnessStep[],
  options: PolicyOptions,
): HarnessResult[] {
  return steps.map(({ event, world }) => {
    const run = runPolicy(policy, { event, state: harnessState(world), options });
    return {
      event: event.id,
      type: event.type,
      matched: run.matched,
      reason: run.reason,
      proposals: run.proposals,
    };
  });
}

/** One proposal in words. */
export function describeProposal(p: Proposal | ErrorProposal): string {
  switch (p.type) {
    case "wake": {
      const on = p.subject ? ` on ${p.subject.type} ${p.subject.ref}` : "";
      return `wake ${p.person} (${p.kind})${on}: ${p.instruction}`;
    }

    case "act": {
      const ops = p.ops.map((o) => `${o.op} ${o.ticket}`).join(", ");
      return `act for ${p.as}: ${ops}${p.note ? ` (note: ${p.note})` : ""}`;
    }

    case "suppress":
      return `suppress waking ${p.person}${p.kind ? ` (${p.kind})` : ""}: ${p.reason}`;
    default:
      return `${p.type}: ${p.reason}`;
  }
}

/** A replay as text, one block per event, for a snapshot. */
export function formatReplay(results: readonly HarnessResult[]): string {
  return results
    .map((r) => {
      const head = `${r.type} ${r.event}: ${r.matched ? "matched" : "no"} (${r.reason})`;
      return [head, ...r.proposals.map((p) => `  ${describeProposal(p)}`)].join("\n");
    })
    .join("\n");
}
