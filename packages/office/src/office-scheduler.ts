import type { Scheduler } from "./scheduler/index.js";
import type { Store } from "./store/types.js";
import { recipeFor } from "./recipes.js";
import type { WorkState } from "./workstate/index.js";

/**
 * Every queued item reaches the scheduler through here: it gets its recipe (if any) and the agent hears of it. A held
 * item is offered once its hold runs out (`onReleased` of the scheduler).
 */
export function notifyingScheduler(deps: {
  scheduler: Scheduler;
  store: Store;
  workState: WorkState;
  notify: (person: string) => void;
}): Scheduler {
  const { scheduler, store, workState, notify } = deps;
  return {
    ...scheduler,
    async enqueue(item) {
      // A wake folded into a held item is not new work: the item has its recipe already.
      let folded = false;
      const { coalesce } = item;
      const created = await scheduler.enqueue(
        coalesce
          ? {
              ...item,
              coalesce: {
                ...coalesce,
                fold: (into) => {
                  folded = true;
                  return coalesce.fold(into);
                },
              },
            }
          : item,
      );

      const recipe = folded ? undefined : await recipeFor(created, store, workState);
      if (recipe) {
        await store.appendJournal(created.id, "office", recipe);
      }

      notify(created.person);
      return created;
    },
    async retry(itemId, request) {
      const item = await scheduler.retry(itemId, request);
      if (item) {
        notify(item.person);
      }

      return item;
    },
  };
}
