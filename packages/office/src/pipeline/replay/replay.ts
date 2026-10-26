import { createStaticWorkflowState } from "@outstaff/core";
import { coalesceWakes } from "../coalesce.js";
import type { PendingWake } from "../coalesce.types.js";
import { evaluatePipeline } from "../evaluate.js";
import type { PipelineEvent } from "../events.types.js";
import type { PipelineState } from "../state.types.js";
import { derivedEvents } from "./merge.js";
import { pipelineSide } from "./pipeline-side.js";
import type {
  ReplayResult,
  ReplayRow,
  ReplayScenario,
  ReplaySetup,
  ReplayWorld,
  Side,
} from "./replay.types.js";
import { todaySide } from "./today.js";

const NOTE = /^(intended fix|regression): \S/;

const stateOf = (world: ReplayWorld): PipelineState => ({
  ...createStaticWorkflowState(world),
  readyTickets: (person) => world.ready?.[person] ?? [],
});

const sameKeys = (a: Side, b: Side) =>
  JSON.stringify(a.keys.toSorted()) === JSON.stringify(b.keys.toSorted());

/**
 * Runs every event of the scenarios through today's engine rules and through the pipeline, side by side. A merge step
 * also runs the events each side derives from it. Pure: nothing is applied or stored.
 */
export function runReplay(scenarios: readonly ReplayScenario[], setup: ReplaySetup): ReplayResult {
  const problems: string[] = [];
  const wakes: PendingWake[] = [];
  const judge = (
    event: PipelineEvent,
    world: ReplayWorld,
    on: { today: boolean; pipeline: boolean; derived: boolean },
    note: string | undefined,
  ): ReplayRow => {
    const state = stateOf(world);
    const today = on.today
      ? todaySide(event, state, setup)
      : { shown: ["(not raised today)"], keys: [] };

    let pipeline: Side = { shown: ["(not raised)"], keys: [] };
    if (on.pipeline) {
      const trace = evaluatePipeline(event, state, setup.policies, setup.pipelineOptions);
      pipeline = pipelineSide(trace);
      for (const d of trace.decisions) {
        if (d.type === "wake") {
          wakes.push({ wake: d, eventId: event.id, at: event.at });
        }
      }
    }

    const same = sameKeys(today, pipeline);
    if (!same && note === undefined) {
      problems.push(`${event.id}: the two sides decide differently and there is no note`);
    } else if (same && note !== undefined) {
      problems.push(`${event.id}: has a note, but both sides decide the same`);
    } else if (note !== undefined && !NOTE.test(note)) {
      problems.push(`${event.id}: a note starts with "intended fix: " or "regression: "`);
    }

    return {
      event,
      derived: on.derived,
      today: today.shown,
      pipeline: pipeline.shown,
      same,
      note,
    };
  };

  const result = scenarios.map((s) => ({
    title: s.title,
    rows: s.steps.flatMap((step) => [
      judge(step.event, step.world, { today: true, pipeline: true, derived: false }, step.note),
      ...(step.merge
        ? derivedEvents(step).map((d) =>
            judge(d.event, step.world, { ...d, derived: true }, step.merge?.notes?.[d.event.id]),
          )
        : []),
    ]),
  }));

  const coalesced = coalesceWakes(wakes, setup.coalesceMs).map((c) => ({
    person: c.person,
    subject: `${c.subject.type} ${c.subject.ref}`,
    kind: c.kind,
    events: c.events,
  }));

  return { scenarios: result, coalesced, problems };
}
