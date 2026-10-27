import { createOfficeActExecutor } from "./act/office-executor.js";
import { createLivePipeline } from "./live/live.js";
import type { OfficePipeline, OfficePipelineOptions } from "./office-pipeline.types.js";
import { createShadowPipeline } from "./shadow.js";
import { createStoreTraceStore } from "./store-traces.js";

type Traces = OfficePipeline["traces"];

function shadow(opts: OfficePipelineOptions, traces: Traces): OfficePipeline {
  const { team, clock, logger } = opts;
  const runner = createShadowPipeline({ team, state: opts.workState, traces, clock, logger });
  return {
    mode: "shadow",
    runner,
    traces,
    async route(event, meta, engine) {
      await runner.handle(event, meta);
      const outcomes = await engine();
      await runner.engineDid(meta, outcomes);
      return outcomes;
    },
    async idle(event, pull) {
      await runner.judge(event);
      return pull();
    },
  };
}

function live(opts: OfficePipelineOptions, traces: Traces): OfficePipeline {
  const executor = createOfficeActExecutor({
    team: opts.team,
    tracker: opts.ports.tracker,
    knowledge: opts.ports.knowledge,
    traces,
  });

  const runner = createLivePipeline({ ...opts, executor, traces });
  return {
    mode: "live",
    runner,
    traces,
    route: (event, meta) => runner.handle(event, meta),
    idle: (event) => runner.judge(event),
  };
}

/** Proposed (decision 0016): the event pipeline beside the engine, off unless `office.pipeline` says otherwise. */
export function createOfficePipeline(opts: OfficePipelineOptions): OfficePipeline {
  const traces = createStoreTraceStore(opts.store);
  const mode = opts.team.office?.pipeline ?? "off";
  if (mode === "off") {
    return {
      mode,
      traces,
      route: (_event, _meta, engine) => engine(),
      idle: (_event, pull) => pull(),
    };
  }

  return mode === "shadow" ? shadow(opts, traces) : live(opts, traces);
}
