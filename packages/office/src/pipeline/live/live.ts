import { configurePipeline } from "#/pipeline/configure.js";
import { evaluatePipeline } from "#/pipeline/evaluate.js";
import { toPipelineEvent } from "#/pipeline/from-workflow.js";
import type { Act, Decision, Notify, Wake } from "#/pipeline/decisions.types.js";
import type { PipelineEvent } from "@outstaff/policy";
import type { PipelineRunner } from "#/pipeline/runner.types.js";
import type { LiveOptions } from "./live.types.js";
import { stopWork } from "./stop.js";
import { enqueueWake } from "./wake.js";

/** The decisions the agents carry out: acts, and notices to humans. */
const handedOn = (d: Decision): d is Act | Notify => d.type === "act" || d.type === "notify";

/**
 * The pipeline deciding on every event: each event is judged and traced, its wakes are queued, its acts carried out
 * and its stops made. Errors propagate, so intake delivers the event again; the trace, the queue, the acts and the
 * stops are all idempotent per event.
 */
export function createLivePipeline(opts: LiveOptions): PipelineRunner {
  const { traces, clock, logger, executor, workState: state } = opts;
  const { policies, options, issues } = configurePipeline(
    opts.team,
    opts.policies,
    opts.capabilities,
  );

  for (const issue of issues) {
    logger.warn(`pipeline: ${issue}`);
  }

  /**
   * The agent makes an act; the office reads its tickets again when the agent answers (see the act desk). A notice is
   * held a moment, merged with the human's other notices, then sent by the agent as one direct message.
   */
  const handOn = async (d: Act | Notify, event: { id: string; at: string }) => {
    await (d.type === "act"
      ? executor.execute(d, event.id)
      : opts.notices?.add(d, event.id, event.at));
  };

  /**
   * Wakes are queued one at a time: finding the live item a wake joins and queuing a new one is one step, so two events
   * judged at once (a ticket created for an agent and the idle pull after its hand-back) never queue two items for one
   * subject.
   */
  let wakes: Promise<unknown> = Promise.resolve();
  const queueWake = (d: Wake, event: PipelineEvent) => {
    const run = wakes.then(() => enqueueWake(d, event, opts));
    wakes = run.catch(() => undefined);
    return run;
  };

  const runner: PipelineRunner = {
    async handle(raw, meta) {
      const event = toPipelineEvent(raw, meta, clock.now().toISOString());
      if (!event) {
        return undefined;
      }

      // The tracker's echo of an office act carries the act's id, and wakes no one (see the invariants).
      const echo = await opts.echoOf?.(event, state);
      return runner.judge(echo ? { ...event, data: { ...event.data, echo } } : event);
    },

    async judge(event) {
      const trace = evaluatePipeline(event, state, policies, options);
      await traces.record(trace);
      // Judged on the state before it: a silent hand-back holds its ticket from the idle pull only after.
      await state.heard(event);
      let queued = false;
      for (const d of trace.decisions) {
        if (d.type === "stop") {
          const { canceled, noticed } = await stopWork(d, event, opts);
          Object.assign(d, { canceled, noticed });
          queued = true;
          continue;
        }

        if (handedOn(d)) {
          await handOn(d, event);
          continue;
        }

        if (d.type === "wake") {
          const { itemId, folded } = await queueWake(d, event);
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

      // The trace says which item each wake queued, and what each stop canceled.
      if (queued) {
        await traces.record(trace);
      }

      return trace;
    },
  };

  return runner;
}
