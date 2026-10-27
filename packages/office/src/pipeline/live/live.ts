import { configurePipeline } from "../configure.js";
import { evaluatePipeline } from "../evaluate.js";
import { toPipelineEvent } from "../from-workflow.js";
import type { ShadowPipeline } from "../shadow.types.js";
import type { PipelineState } from "../state.types.js";
import type { LiveOptions } from "./live.types.js";
import { enqueueWake } from "./wake.js";

/**
 * The pipeline deciding instead of the engine (`office.pipeline: live`): each event is judged and traced, its wakes
 * are queued and its acts carried out. Errors propagate, so intake delivers the event again; the trace, the queue
 * and the acts are all idempotent per event.
 */
export function createLivePipeline(opts: LiveOptions): ShadowPipeline {
  const { traces, clock, logger, executor } = opts;
  const { policies, options, issues } = configurePipeline(opts.team);
  for (const issue of issues) {
    logger.warn(`pipeline: ${issue}`);
  }

  // As in shadow mode: the work state does not record when a ticket entered ready yet.
  const state: PipelineState = { ...opts.workState, readyTickets: () => [] };

  return {
    async handle(raw, meta) {
      const event = toPipelineEvent(raw, meta, clock.now().toISOString());
      if (!event) {
        return undefined;
      }

      const trace = evaluatePipeline(event, state, policies, options);
      await traces.record(trace);
      let queued = false;
      for (const d of trace.decisions) {
        // Chat stays with the chat desk until chat messages are events of their own.
        if (d.type === "wake" && d.subject.type !== "chat") {
          const { itemId, joined } = await enqueueWake(d, event, opts);
          // The same decision object sits in its policy's trace too, so both show the item.
          d.itemId = itemId;
          queued = true;
          logger.info(
            `pipeline: ${joined ? "joined" : "queued"} work item ${itemId} for ${d.person} (${d.kind})`,
          );
        } else if (d.type === "act") {
          await executor.execute(d, event.id);
        }
      }

      // The trace says which item each wake queued.
      if (queued) {
        await traces.record(trace);
      }

      return trace;
    },
  };
}
