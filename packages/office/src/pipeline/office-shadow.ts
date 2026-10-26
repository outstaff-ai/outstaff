import { createShadowPipeline } from "./shadow.js";
import type { OfficeShadow, OfficeShadowDeps } from "./shadow.types.js";
import { createStoreTraceStore } from "./store-traces.js";

/**
 * Proposed (decision 0016): the event pipeline beside the engine. With `office.pipeline: shadow` each event is judged
 * by the pipeline before the engine applies anything, so both judge the same state: after the engine it would see the
 * engine's own moves and assignments already made, decide "nothing to change", and its traces could not be compared
 * with the engine's. The pipeline never throws, so it cannot hold up or fail the engine. Off, only the engine judges.
 */
export function createOfficeShadow(deps: OfficeShadowDeps): OfficeShadow {
  const { team, workState, store, clock, log, engine, track } = deps;
  const pipeline =
    team.office?.pipeline === "shadow"
      ? createShadowPipeline({
          team,
          state: workState,
          traces: createStoreTraceStore(store),
          clock,
          logger: log,
        })
      : undefined;

  return {
    pipeline,
    async judge(event, meta) {
      if (pipeline) {
        await track(pipeline.handle(event, meta));
      }

      return track(engine.handle(event, meta));
    },
  };
}
