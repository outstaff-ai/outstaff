import { applyActOps, trackerMemberOf, type ActOutcome } from "@outstaff/core";
import type { QueuedAct } from "@outstaff/protocol";
import type { ActMaker, ActMakerOptions } from "./acts.types.js";

/**
 * Makes the acts the office sends with the agent's own tracker and knowledge ports, so the changes are the agent's,
 * and answers each with what it did. No model runs. Acts are made one at a time, in the order they came; an act sent
 * again (the answer was lost) is answered again without being made twice.
 */
export function createActMaker(opts: ActMakerOptions): ActMaker {
  const { env, office, log } = opts;
  const made = new Map<string, ActOutcome>();
  let chain: Promise<void> = Promise.resolve();

  async function make(act: QueuedAct) {
    let outcome = made.get(act.id);
    if (!outcome) {
      const { tracker, knowledge, team } = env;
      outcome = await applyActOps(act.ops, { tracker, knowledge }, (target) =>
        trackerMemberOf(target, team, tracker!),
      );

      made.set(act.id, outcome);
      if (outcome.ok) {
        log.info("made an act", { id: act.id, results: outcome.results });
      } else {
        log.warn("an act failed", { id: act.id, error: outcome.error });
      }
    }

    const { ok, results, error } = outcome;
    await office
      .actResult({ id: act.id, ok, results, ...(error ? { error } : {}) })
      .catch((e: unknown) => {
        // Not answered: the office sends the act again with the next connection, and the answer is sent then.
        log.warn("could not answer an act", { id: act.id, error: String(e) });
      });
  }

  return {
    make(acts) {
      chain = chain.then(async () => {
        for (const act of acts) {
          await make(act);
        }
      });

      return chain;
    },
  };
}
