import {
  createEvaluationContext,
  createStaticWorkflowState,
  type EvaluationContext,
  type StaticWorkflowData,
  type WorkflowPr,
} from "@outstaff/core";
import type { PipelineEvent, PipelineEventType } from "#/pipeline/events.types.js";
import type { PipelineOptions, PipelineState, ReadyTicket } from "#/pipeline/state.types.js";

export const REPO = { host: "github.com", owner: "acme-example", name: "shop" };
export const prRef = (number: number) => ({ repo: REPO, number });

export const OPTS: PipelineOptions = {
  people: ["sam", "noor", "mira", "leo", "kofi", "priya"],
  humans: [{ name: "Ada Admin", identities: { vcs: "ada-admin", tracker: "ada.admin" } }],
  approvers: ["humans"],
  fallbackRequester: "ada.admin",
};

/** An open pull request by sam into main, unless told otherwise. */
export function pr(number: number, o: Partial<WorkflowPr> = {}): WorkflowPr {
  return {
    ref: prRef(number),
    title: `Change ${number}`,
    headRef: `sam/acme-${number}`,
    baseRef: "main",
    draft: false,
    state: "open",
    author: { login: "acme-sam[bot]", kind: "agent", person: "sam" },
    ...o,
  };
}

export const HUMAN_AUTHOR = { login: "grace-lead", kind: "human" } as const;

export type World = StaticWorkflowData & { ready?: Record<string, ReadyTicket[]> };

export const stateOf = (world: World = {}): PipelineState => ({
  ...createStaticWorkflowState(world),
  readyTickets: (person) => world.ready?.[person] ?? [],
});

export function event(
  type: PipelineEventType,
  o: Partial<Omit<PipelineEvent, "type">> = {},
): PipelineEvent {
  return {
    id: `test:${type}`,
    type,
    at: "2026-10-05T09:00:00.000Z",
    subject: {},
    actor: { kind: "human", id: "ada-admin" },
    data: {},
    ...o,
  };
}

export const ctxOf = (e: PipelineEvent, world: World = {}): EvaluationContext =>
  createEvaluationContext(e, stateOf(world), OPTS);
