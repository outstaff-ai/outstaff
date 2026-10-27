import {
  explainWorkflow,
  WORKFLOW_EVENT_TYPES,
  type Effect,
  type WorkflowEvent,
  type WorkflowState,
} from "@outstaff/core";
import { awaitsReview } from "#/engine/feedback.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { Outcome } from "#/pipeline/compare/compare.types.js";
import { fromEffect, KIND_ALIASES } from "#/pipeline/compare/outcomes.js";
import type { ReplaySetup, Side } from "./replay.types.js";

const TODAY_TYPES: ReadonlySet<string> = new Set(WORKFLOW_EVENT_TYPES);

export function effectKey(e: Effect): string {
  switch (e.type) {
    case "schedule":
      return `wake ${e.person} (${KIND_ALIASES[e.kind] ?? e.kind})`;
    case "move":
      return `move ${e.ticket} to ${e.to}`;
    case "assign":
      return e.to ? `assign ${e.ticket} to ${e.to.kind} ${e.to.id}` : `unassign ${e.ticket}`;
    case "comment":
      return `comment on ${"ticket" in e.on ? e.on.ticket : `#${e.on.pr.number}`}`;
  }
}

/** Why the engine would not queue a schedule effect, as `schedule()` in engine.ts checks before touching the queue. */
function skipped(e: Effect, event: PipelineEvent, setup: ReplaySetup): string | undefined {
  if (e.type !== "schedule") {
    return undefined;
  }

  if (!setup.people.includes(e.person)) {
    return `${e.person} is not on the team`;
  }

  const self = event.actor.kind === "agent" && event.actor.id === e.person;
  return self && event.type !== "agent.handed_back" ? `${e.person} caused it` : undefined;
}

/**
 * What today's engine decides for an event: its workflow rules' effects, with the checks the engine makes before
 * applying them that need no store (untrusted, pending review comments, self-caused schedules). Pure; nothing applied.
 */
export function todaySide(event: PipelineEvent, state: WorkflowState, setup: ReplaySetup): Side {
  if (!TODAY_TYPES.has(event.type)) {
    return { shown: ["(no such event today)"], outcomes: [] };
  }

  if (event.data["untrusted"] === true || awaitsReview(event)) {
    return { shown: ["(ignored)"], outcomes: [] };
  }

  const effects = explainWorkflow(
    event as unknown as WorkflowEvent,
    state,
    setup.rules,
    setup.workflowOptions,
  ).effects;

  const shown: string[] = [];
  const outcomes: Outcome[] = [];
  for (const e of effects) {
    const key = effectKey(e);
    const skip = skipped(e, event, setup);
    if (skip) {
      shown.push(`(${key}: skipped, ${skip})`);
    } else {
      outcomes.push(fromEffect(e));
      shown.push(e.type === "schedule" ? key : `${key} (as the office)`);
    }
  }

  return { shown, outcomes };
}
