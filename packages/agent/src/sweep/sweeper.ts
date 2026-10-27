import { reason } from "#/runner/reason.js";
import type { Sweeper, SweeperOptions } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The states of an item whose worktree and scratch folder go; every other state is work the person still has. */
const FINISHED = new Set(["done", "canceled", "not_yours", "unknown"]);

/** The states in which the item is still the person's, so its journal takes a note. */
const OWN_FINISHED = new Set(["done", "canceled"]);

const WHY: Record<string, string> = {
  done: "the item is done",
  canceled: "the item was canceled",
  not_yours: "the item belongs to someone else now",
  unknown: "the office has no such item",
};

export function createSweeper(opts: SweeperOptions): Sweeper {
  const { office, workspaces, clock, log } = opts;
  const everyMs = opts.everyMs ?? DAY_MS;
  let running = false;
  let cancel: (() => void) | undefined;

  /** Writes the removal to the log and, while the office still lets the person write to the item, to its journal. */
  async function note(workItemId: string, state: string) {
    const text = `Removed the worktree and scratch folder: ${WHY[state]}.`;
    log.info("swept the workspace of an item", { workItemId, state });
    if (OWN_FINISHED.has(state)) {
      await office.journal(workItemId, text).catch((e: unknown) => {
        log.warn("could not journal a sweep", { workItemId, error: reason(e) });
      });
    }
  }

  async function sweep() {
    const held = workspaces.held();
    if (held.length === 0) {
      return [];
    }

    const removed: string[] = [];
    for (const { workItemId, state } of await office.workStatus(held)) {
      if (!FINISHED.has(state) || !held.includes(workItemId)) {
        continue;
      }

      await workspaces.release(workItemId);
      removed.push(workItemId);
      await note(workItemId, state);
    }

    return removed;
  }

  async function tick() {
    try {
      await sweep();
    } catch (e) {
      log.warn("could not sweep the workspaces", { error: reason(e) });
    }

    if (running) {
      cancel = clock.setTimeout(() => void tick(), everyMs);
    }
  }

  return {
    sweep,

    start() {
      if (running) {
        return;
      }

      running = true;
      void tick();
    },

    stop() {
      running = false;
      cancel?.();
    },
  };
}
