import type { StaticTicket } from "@outstaff/core";
import type { PipelineEvent } from "@outstaff/policy";
import { describeDecision } from "#/pipeline/describe.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { BUILT_IN_POLICIES } from "#/pipeline/policies/index.js";
import { event, OPTS, pr, prRef, stateOf, type World } from "#/pipeline/__tests__/support.js";

export { evaluatePipeline } from "#/pipeline/evaluate.js";
export { BUILT_IN_POLICIES } from "#/pipeline/policies/index.js";
export {
  event,
  HUMAN_AUTHOR,
  OPTS,
  pr,
  prRef,
  stateOf,
  type World,
} from "#/pipeline/__tests__/support.js";

export const ADA: PipelineEvent["actor"] = { kind: "human", id: "ada-admin" };
export const SAM = { kind: "agent" as const, id: "sam" };
export const OFFICE = { kind: "automation" as const, id: "office" };

/** The built-in policies on an event: the trace the bus and the aggregation make. */
export const traceOf = (e: PipelineEvent, world: World = {}) =>
  evaluatePipeline(e, stateOf(world), BUILT_IN_POLICIES, OPTS);

/** What one built-in policy makes of an event, through the bus and the aggregation: its decisions, or the condition that failed. */
export function judge(id: string, e: PipelineEvent, world: World = {}) {
  const trace = traceOf(e, world);
  const p = trace.policies.find((t) => t.policy === id)!;
  return p.matched
    ? trace.decisions.filter((d) => d.policy === id).map(describeDecision)
    : { failed: p.failed ?? p.reason };
}

export const t = (
  status: StaticTicket["status"],
  assignee?: string,
  extra: Partial<StaticTicket> = {},
) => ({
  status,
  ...(assignee
    ? {
        assignee: {
          id: assignee,
          kind: OPTS.people.includes(assignee) ? ("agent" as const) : ("human" as const),
        },
      }
    : {}),
  ...extra,
});

/** A team's tracker names for the statuses a move goes between; intake keeps them beside the canonical ones. */
const TRACKER_NAMES: Record<string, string> = {
  ready: "Up Next",
  active: "In Progress",
  review: "In Review",
};

/** A move as intake hands it on, from ready: canonical statuses, with the tracker's names beside them. */
export const moveData = (to: string) => ({
  from: "ready",
  fromName: TRACKER_NAMES["ready"],
  to,
  toName: TRACKER_NAMES[to],
});

export const onPr = (
  type: PipelineEvent["type"],
  data: Record<string, unknown> = {},
  actor: PipelineEvent["actor"] = ADA,
) => event(type, { subject: { pr: prRef(9) }, actor, data });

export const prWorld = (
  o: Parameters<typeof pr>[1] = {},
  status: StaticTicket["status"] = "review",
): World => ({
  prs: [pr(9, o)],
  links: { 9: "ACME-9" },
  tickets: { "ACME-9": t(status, "sam") },
});
