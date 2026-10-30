import { createAgentActExecutor } from "./act/agent-executor.js";
import { createActDesk } from "./act/desk.js";
import { createLivePipeline } from "./live/live.js";
import type { OfficePipeline, OfficePipelineOptions } from "./office-pipeline.types.js";
import { createStoreTraceStore } from "./store-traces.js";

/**
 * The event pipeline as the office runs it (decision 0018): it decides on every event, and its acts go to the agents
 * that make them.
 */
export function createOfficePipeline(opts: OfficePipelineOptions): OfficePipeline {
  const traces = createStoreTraceStore(opts.store);
  const acts = createActDesk({ ...opts, traces });
  const executor = createAgentActExecutor({ traces, acts });

  return { runner: createLivePipeline({ ...opts, executor, traces }), traces, acts };
}
