import type { StaticWorkflowData } from "@outstaff/core";
import type { PipelineEvent, PipelineEventType } from "./events.types.js";
import type { ReadyTicket, WaitingAgent } from "./policy.types.js";
import type { ErrorProposal, Proposal } from "./proposal.types.js";

/**
 * The work state after an event, as plain data: tickets, pull requests and their links, the ready tickets, and the
 * agents waiting on a human, by ticket and human.
 */
export interface HarnessWorld extends StaticWorkflowData {
  ready?: Record<string, ReadyTicket[]>;
  waiting?: Record<string, Record<string, WaitingAgent[]>>;
}

/** One recorded event and the world after it. */
export interface HarnessStep {
  event: PipelineEvent;
  world?: HarnessWorld | undefined;
}

/** What the policy made of one event. */
export interface HarnessResult {
  event: string;
  type: PipelineEventType;
  matched: boolean;
  reason: string;
  proposals: (Proposal | ErrorProposal)[];
}
