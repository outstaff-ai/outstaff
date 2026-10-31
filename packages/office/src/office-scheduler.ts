import { mergeRepo, type Scheduler } from "./scheduler/index.js";
import type { Store, WorkItem } from "./store/types.js";
import { recipeFor } from "./recipes.js";
import type { WorkState } from "./workstate/index.js";

/** The people whose merge waits in the repository of a merge that just ended: they may start theirs now. */
async function waitingMerges(store: Store, ended: WorkItem): Promise<Set<string>> {
  const repo = mergeRepo(ended);
  if (!repo) {
    return new Set();
  }

  const queued = await store.listItems({ status: "queued" });
  return new Set(queued.filter((i) => mergeRepo(i) === repo).map((i) => i.person));
}

/**
 * Every queued item reaches the scheduler through here: it gets its recipe (if any) and the agent hears of it. A held
 * item is offered once its hold runs out (`onReleased` of the scheduler). When a merge ends, however it ends, the
 * people whose merges waited for it in the same repository hear of theirs.
 */
export function notifyingScheduler(deps: {
  scheduler: Scheduler;
  store: Store;
  workState: WorkState;
  notify: (person: string) => void;
}): Scheduler {
  const { scheduler, store, workState, notify } = deps;
  const ended = async <T>(result: T, item: WorkItem): Promise<T> => {
    for (const person of await waitingMerges(store, item)) {
      notify(person);
    }

    return result;
  };

  return {
    ...scheduler,
    async finish(itemId, input) {
      const item = await scheduler.finish(itemId, input);
      return ended(item, item);
    },
    async fail(itemId, error) {
      const failed = await scheduler.fail(itemId, error);
      return ended(failed, failed.item);
    },
    async interrupt(itemId, outcome) {
      const item = await scheduler.interrupt(itemId, outcome);
      return ended(item, item);
    },
    async block(itemId, reason) {
      const blocked = await scheduler.block(itemId, reason);
      return ended(blocked, blocked.item);
    },
    // A merge run the tick found stale is retried or blocked there: its repository's waiting merges hear of it too.
    start(onTick) {
      scheduler.start(async (result) => {
        for (const item of [...result.retried, ...result.blocked.map((b) => b.item)]) {
          await ended(undefined, item);
        }

        onTick?.(result);
      });
    },
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
