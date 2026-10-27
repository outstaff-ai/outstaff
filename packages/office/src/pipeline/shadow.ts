import { compareOutcomes } from "./compare/compare.js";
import { engineRecord, fromDecisions } from "./compare/outcomes.js";
import { configurePipeline } from "./configure.js";
import { evaluatePipeline } from "./evaluate.js";
import { toPipelineEvent } from "./from-workflow.js";
import type { ShadowOptions, ShadowPipeline } from "./shadow.types.js";
import type { PipelineState } from "./state.types.js";

export function createShadowPipeline(opts: ShadowOptions): ShadowPipeline {
  const { traces, clock, logger } = opts;
  const { policies, options, issues } = configurePipeline(opts.team);
  for (const issue of issues) {
    logger.warn(`pipeline: ${issue}`);
  }

  // The work state does not record when a ticket entered ready yet, so no idle pull is decided in shadow mode.
  const state: PipelineState = { ...opts.state, readyTickets: () => [] };

  return {
    async handle(raw, meta) {
      const event = toPipelineEvent(raw, meta, clock.now().toISOString());
      if (!event) {
        return undefined;
      }

      try {
        const trace = evaluatePipeline(event, state, policies, options);
        await traces.record(trace);
        logger.debug(`pipeline (shadow): ${event.type} ${event.id}`, {
          decisions: trace.decisions.map((d) => d.type),
        });

        return trace;
      } catch (error) {
        logger.warn("pipeline (shadow) failed on an event", { id: event.id, error: String(error) });
        return undefined;
      }
    },

    async engineDid(meta, outcomes) {
      const id = `${meta.source}:${meta.externalId}`;
      try {
        const trace = await traces.get(id);
        if (!trace) {
          return undefined;
        }

        const engine = engineRecord(outcomes);
        const done = {
          ...trace,
          engine,
          comparison: compareOutcomes(engine.effects, fromDecisions(trace.decisions)),
        };

        await traces.record(done);
        return done;
      } catch (error) {
        logger.warn("pipeline (shadow) could not record what the engine did", {
          id,
          error: String(error),
        });

        return undefined;
      }
    },
  };
}
