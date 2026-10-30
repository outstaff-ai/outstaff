import { createOfficeActExecutor } from "./act/office-executor.js";
import { createLivePipeline } from "./live/live.js";
import type { OfficePipeline, OfficePipelineOptions } from "./office-pipeline.types.js";
import { createStoreTraceStore } from "./store-traces.js";

/** The event pipeline as the office runs it (decision 0018): it decides on every event, and its acts are carried out. */
export function createOfficePipeline(opts: OfficePipelineOptions): OfficePipeline {
  const traces = createStoreTraceStore(opts.store);
  const executor = createOfficeActExecutor({
    team: opts.team,
    tracker: opts.ports.tracker,
    knowledge: opts.ports.knowledge,
    traces,
  });

  return { runner: createLivePipeline({ ...opts, executor, traces }), traces };
}
