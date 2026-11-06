import type { WorkSourceOptions } from "./work-source.types.js";

/** Whether the agent accepted an item the office offered it. */
type AcceptedOf = (id: string) => Promise<boolean>;

/** Why an item the agent is not running goes back to the queue. */
const why = (accepted: boolean) =>
  accepted
    ? "the agent reconnected without this item running, so its run was abandoned."
    : "the agent reconnected without having taken this offer.";

/**
 * Compares the items the office has active for a person with the ones the agent says it runs, when it says hello.
 * An active item the agent does not run (an offer it never took, or a run it lost) is requeued; one the agent runs
 * and the office does not have active is only logged. Returns the ids the agent carries on with.
 */
export function reconciler(
  opts: Pick<WorkSourceOptions, "store" | "scheduler" | "logger">,
  acceptedOf: AcceptedOf,
) {
  const { store, scheduler, logger } = opts;

  return async (person: string, running: string[]): Promise<string[]> => {
    const active = await store.listItems({ person, status: "active" });
    const kept: string[] = [];
    for (const item of active) {
      if (running.includes(item.id)) {
        kept.push(item.id);
      } else {
        await scheduler.abandon(item.id, why(await acceptedOf(item.id)));
      }
    }

    for (const id of running.filter((r) => !kept.includes(r))) {
      logger?.warn("the agent runs an item the office does not have active", { person, item: id });
    }

    return kept;
  };
}
