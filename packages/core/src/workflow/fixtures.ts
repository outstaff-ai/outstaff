import type { CanonicalStatus } from "../ports/status.js";
import { createStaticWorkflowState, type StaticTicket } from "./state.js";
import type { PrRef, WorkflowEvent, WorkflowPr } from "./types.js";

export const repo = { owner: "acme", name: "app" };
export const ref = (number: number): PrRef => ({ repo, number });

export function pr(number: number, over: Partial<WorkflowPr> = {}): WorkflowPr {
  return {
    ref: ref(number),
    title: `Change ${number}`,
    url: `https://git.example/acme/app/pull/${number}`,
    headRef: `feat-${number}`,
    baseRef: "main",
    draft: false,
    state: "open",
    author: { login: "ada-bot", kind: "agent", person: "ada" },
    ...over,
  };
}

export function ticket(status: CanonicalStatus, over: Partial<StaticTicket> = {}): StaticTicket {
  return { status, lastWorker: "ada", requester: "grace", ...over };
}

export function world(
  opts: {
    status?: CanonicalStatus;
    ticket?: Partial<StaticTicket>;
    prs?: WorkflowPr[];
    docs?: Record<string, string>;
  } = {},
) {
  return createStaticWorkflowState({
    tickets: { "ACME-1": ticket(opts.status ?? "review", opts.ticket) },
    prs: opts.prs ?? [pr(10)],
    links: { 10: "ACME-1", 11: "ACME-1", 12: "ACME-1" },
    roles: { reviewer: "rex", pm: "pia" },
    docs: opts.docs ?? { "doc-1": "ada" },
  });
}

export const human = { kind: "human", id: "grace" } as const;
export const agent = { kind: "agent", id: "ada" } as const;
export const automation = { kind: "automation", id: "office" } as const;

export function ev(type: WorkflowEvent["type"], over: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return { type, subject: { pr: ref(10) }, actor: human, data: {}, ...over };
}
