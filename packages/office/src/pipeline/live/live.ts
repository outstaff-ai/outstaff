import { configurePipeline } from "#/pipeline/configure.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { toPipelineEvent } from "#/pipeline/from-workflow.js";
import type { PipelineRunner } from "#/pipeline/runner.types.js";
import type { LiveOptions } from "./live.types.js";
import { enqueueWake } from "./wake.js";

/**
 * The pipeline deciding on every event: each event is judged and traced, its wakes are queued and its acts carried
 * out. Errors propagate, so intake delivers the event again; the trace, the queue and the acts are all idempotent per
 * event.
 */
export function createLivePipeline(opts: LiveOptions): PipelineRunner {
  const { traces, clock, logger, executor, workState: state } = opts;
  const { policies, options, issues } = configurePipeline(opts.team, opts.policies);
  for (const issue of issues) {
    logger.warn(`pipeline: ${issue}`);
  }

  const runner: PipelineRunner = {
    async handle(raw, meta) {
      const event = toPipelineEvent(raw, meta, clock.now().toISOString());
      return event ? runner.judge(event) : undefined;
    },

    async judge(event) {
      const trace = evaluatePipeline(event, state, policies, options);
      await traces.record(trace);
      let queued = false;
      for (const d of trace.decisions) {
        if (d.type === "act") {
          await executor.execute(d, event.id);
          continue;
        }

        if (d.type === "wake") {
          const { itemId, folded } = await enqueueWake(d, event, opts);
          d.itemId = itemId;
          if (folded) {
            d.folded = folded;
          }

          queued = true;
          logger.info(
            `pipeline: ${folded ? "folded the wake into" : "queued"} work item ${itemId} for ${d.person} (${d.kind})`,
          );
        }
      }

      // The trace says which item each wake queued.
      if (queued) {
        await traces.record(trace);
      }

      return trace;
    },
  };

  return runner;
}
