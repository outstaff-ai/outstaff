import type { WorkState } from "@outstaff/protocol";
import { reason } from "#/runner/reason.js";
import type { Sweeper, SweeperOptions } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `agent.sweep.idle_days` when the team file does not set it. */
export const DEFAULT_IDLE_DAYS = 7;

/** The states of an item whose worktree and scratch folder go; every other state is work the person still has. */
const FINISHED = new Set(["done", "canceled", "not_yours", "unknown"]);

/** The states of an item whose worktree and scratch folder go once it has been idle long enough, if nothing is lost. */
const IDLE = new Set(["blocked", "waiting"]);

/** The states in which the item is still the person's, so its journal takes a note. */
const OWN_FINISHED = new Set(["done", "canceled"]);

const WHY: Record<string, string> = {
  done: "the item is done",
  canceled: "the item was canceled",
  not_yours: "the item belongs to someone else now",
  unknown: "the office has no such item",
};

/** Whether an item has been blocked or waiting, with no change, for `days` or more at `now`. */
function idleFor(item: WorkState, now: number, days: number): boolean {
  if (days <= 0 || !IDLE.has(item.state) || !item.updatedAt) {
    return false;
  }

  const at = Date.parse(item.updatedAt);
  return Number.isFinite(at) && now - at >= days * DAY_MS;
}

export function createSweeper(opts: SweeperOptions): Sweeper {
  const { office, workspaces, clock, log } = opts;
  const everyMs = opts.everyMs ?? DAY_MS;
  const idleDays = opts.idleDays ?? DEFAULT_IDLE_DAYS;
  let running = false;
  let cancel: (() => void) | undefined;

  const journal = (workItemId: string, text: string) =>
    office.journal(workItemId, text).catch((e: unknown) => {
      log.warn("could not journal a sweep", { workItemId, error: reason(e) });
    });

  /** Writes the removal to the log and, while the office still lets the person write to the item, to its journal. */
  async function note(workItemId: string, state: string) {
    const text = `Removed the worktree and scratch folder: ${WHY[state]}.`;
    log.info("swept the workspace of an item", { workItemId, state });
    if (OWN_FINISHED.has(state)) {
      await journal(workItemId, text);
    }
  }

  /** Releases an idle item's workspace when nothing in it can be lost; otherwise says why it stays, in the journal once. */
  async function sweepIdle({ workItemId, state }: WorkState, since: number): Promise<boolean> {
    const r = await workspaces.releaseIdle(workItemId, since);
    const idle = `the item has been ${state} for ${idleDays} days or more with no change`;
    if (r.outcome === "released") {
      log.info("swept the workspace of an idle item", { workItemId, state });
      await journal(
        workItemId,
        `Removed the worktree and scratch folder: ${idle}, and everything in the worktree was pushed. The next round makes the worktree again from the branch.`,
      );

      return true;
    }

    if (r.outcome === "kept") {
      log.info("kept the workspace of an idle item", { workItemId, state, reasons: r.reasons });
      if (!r.noted) {
        await journal(
          workItemId,
          `Kept the worktree and scratch folder although ${idle}, because removing it could lose work: ${r.reasons.join("; ")}.`,
        );
      }
    }

    return false;
  }

  async function sweepWorkspaces() {
    const held = workspaces.held();
    if (held.length === 0) {
      return [];
    }

    const since = clock.now().getTime();
    const removed: string[] = [];
    for (const item of await office.workStatus(held)) {
      const { workItemId, state } = item;
      if (!held.includes(workItemId)) {
        continue;
      }

      if (FINISHED.has(state)) {
        await workspaces.release(workItemId);
        removed.push(workItemId);
        await note(workItemId, state);
      } else if (idleFor(item, since, idleDays) && (await sweepIdle(item, since))) {
        removed.push(workItemId);
      }
    }

    return removed;
  }

  /** Sweeps the workspaces, then prunes the caches, which goes ahead when the office cannot be reached. */
  async function sweep() {
    try {
      return await sweepWorkspaces();
    } finally {
      await opts.caches?.prune().catch((e: unknown) => {
        log.warn("could not prune the caches", { error: reason(e) });
      });
    }
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
