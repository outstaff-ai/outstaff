import { createOfficeActExecutor } from "./act/office-executor.js";
import { createLivePipeline } from "./live/live.js";
import type { OfficePipeline, OfficePipelineOptions } from "./office-pipeline.types.js";
import { createShadowPipeline } from "./shadow.js";
import { createStoreTraceStore } from "./store-traces.js";

/** Proposed (decision 0016): the event pipeline beside the engine, off unless `office.pipeline` says otherwise. */
export function createOfficePipeline(opts: OfficePipelineOptions): OfficePipeline {
  const { team, store, clock, logger } = opts;
  const mode = team.office?.pipeline ?? "off";
  const traces = createStoreTraceStore(store);
  if (mode === "off") {
    return { mode, traces, route: (_event, _meta, engine) => engine() };
  }

  if (mode === "shadow") {
    const runner = createShadowPipeline({ team, state: opts.workState, traces, clock, logger });
    return {
      mode,
      runner,
      traces,
      async route(event, meta, engine) {
        await runner.handle(event, meta);
        return engine();
      },
    };
  }

  const executor = createOfficeActExecutor({
    team,
    tracker: opts.ports.tracker,
    knowledge: opts.ports.knowledge,
    traces,
  });

  const runner = createLivePipeline({ ...opts, executor, traces });
  return { mode, runner, traces, route: (event, meta) => runner.handle(event, meta) };
}
