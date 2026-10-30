import { createStaticWorkflowState } from "@outstaff/core";
import { coalesceWakes } from "#/pipeline/coalesce.js";
import type { PendingWake } from "#/pipeline/coalesce.types.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import type { PipelineEvent } from "@outstaff/policy";
import type { PipelineState } from "#/pipeline/state.types.js";
import { decisionLines } from "./decision-lines.js";
import { derivedEvents } from "./merge.js";
import type {
  ReplayResult,
  ReplayRow,
  ReplayScenario,
  ReplaySetup,
  ReplayWorld,
} from "./replay.types.js";

const stateOf = (world: ReplayWorld): PipelineState => ({
  ...createStaticWorkflowState(world),
  readyTickets: (person) => world.ready?.[person] ?? [],
});

/**
 * Runs every event of the scenarios through the pipeline. A merge step also runs the events the pipeline derives
 * from it. Pure: nothing is applied or stored.
 */
export function runReplay(scenarios: readonly ReplayScenario[], setup: ReplaySetup): ReplayResult {
  const wakes: PendingWake[] = [];
  const judge = (event: PipelineEvent, world: ReplayWorld, derived: boolean): ReplayRow => {
    const trace = evaluatePipeline(event, stateOf(world), setup.policies, setup.pipelineOptions);
    for (const d of trace.decisions) {
      if (d.type === "wake") {
        wakes.push({ wake: d, eventId: event.id, at: event.at });
      }
    }

    return { event, derived, decisions: decisionLines(trace) };
  };

  const result = scenarios.map((s) => ({
    title: s.title,
    rows: s.steps.flatMap((step) => [
      judge(step.event, step.world, false),
      ...(step.merge ? derivedEvents(step).map((e) => judge(e, step.world, true)) : []),
    ]),
  }));

  const coalesced = coalesceWakes(wakes).map((c) => ({
    person: c.person,
    subject: `${c.subject.type} ${c.subject.ref}`,
    kind: c.kind,
    events: c.events,
  }));

  return { scenarios: result, coalesced };
}
