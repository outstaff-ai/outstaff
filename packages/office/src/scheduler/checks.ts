import type { Run, WorkItem } from "#/store/types.js";
import type { Checks, ChecksOptions } from "./checks.types.js";
import {
  CHAT_KIND,
  HOUR_MS,
  isLoopGuarded,
  loopGuardVerdict,
  planMove,
  usageVerdict,
} from "./policy.js";
import type { MoveTarget, RunBlock, UsageWindow } from "./policy.types.js";
import type { BlockNotice } from "./types.js";

// Mirrors the team.yaml defaults for a team that sets no `policies`.
const DEFAULT_USAGE = { defer_scheduled_at: 0.85, pause_automatic_at: 0.95 };

export const TEAM_SCOPE = "team";
export const personScope = (person: string) => `person:${person}`;

export function createChecks(opts: ChecksOptions): Checks {
  const { store, team, clock, log, usage, maxRuns, chatSessions } = opts;

  const hasRoom = async (item: Pick<WorkItem, "person" | "kind">) => {
    const active = await store.listItems({ person: item.person, status: "active" });
    return item.kind === CHAT_KIND
      ? active.filter((i) => i.kind === CHAT_KIND).length < chatSessions
      : !active.some((i) => i.kind !== CHAT_KIND);
  };

  const backingOff = (item: Pick<WorkItem, "notBefore">) =>
    item.notBefore !== null && Date.parse(item.notBefore) > clock.now().getTime();

  const getWindows = async (person: string): Promise<UsageWindow[]> => {
    if (!usage) {
      return [];
    }

    try {
      return await usage.windows(person);
    } catch (err) {
      // Fail open: a broken usage feed must not stop humans from being answered.
      log.warn("usage source failed; ignoring usage policy", { person, error: String(err) });
      return [];
    }
  };

  const pauseBlock = async (person: string): Promise<RunBlock | null> => {
    const pauses = await store.listPauses();
    const t = pauses.find((p) => p.scope === TEAM_SCOPE);
    if (t) {
      return { code: "paused_team", reason: `Team paused${t.reason ? `: ${t.reason}` : ""}.` };
    }

    const p = pauses.find((x) => x.scope === personScope(person));
    if (p) {
      return {
        code: "paused_person",
        reason: `${person} paused${p.reason ? `: ${p.reason}` : ""}.`,
      };
    }

    return null;
  };

  const usageBlock = async (
    person: string,
    item: Pick<WorkItem, "trigger">,
    windows?: UsageWindow[],
  ): Promise<RunBlock | null> => {
    if (item.trigger === "human") {
      return null;
    }

    return usageVerdict(
      item.trigger,
      windows ?? (await getWindows(person)),
      team.policies?.usage ?? DEFAULT_USAGE,
    );
  };

  const guardTripped = async (item: WorkItem): Promise<string | null> => {
    if (!isLoopGuarded(item.trigger)) {
      return null;
    }

    const count = await store.countLoopGuard(item.id, HOUR_MS);
    const v = loopGuardVerdict(item.trigger, count, maxRuns);
    return v.tripped ? (v.reason ?? "Loop guard tripped.") : null;
  };

  const openRun = async (itemId: string): Promise<Run | undefined> => {
    const runs = await store.listRuns(itemId);
    return runs.findLast((r) => r.finishedAt === null);
  };

  const blockItem = async (
    item: WorkItem,
    reason: string,
    code: BlockNotice["code"],
  ): Promise<BlockNotice> => {
    const run = await openRun(item.id);
    if (run) {
      await store.finishRun(run.id, { outcome: "blocked", error: reason });
    }

    const updated = await store.updateItem(item.id, { status: "blocked" });
    await store.appendJournal(item.id, "scheduler", `Blocked: ${reason}`);
    log.warn("work item blocked", { item: item.id, person: item.person, code, reason });
    return { item: updated, reason, code };
  };

  const queuedOf = (person: string) => store.listItems({ person, status: "queued" });

  const applyMove = async (itemId: string, target: MoveTarget): Promise<void> => {
    const item = await store.getItem(itemId);
    if (!item) {
      throw new Error(`unknown work item: ${itemId}`);
    }

    if (item.status !== "queued") {
      throw new Error(`work item ${itemId} is ${item.status}; only queued items can be moved`);
    }

    const queue = await queuedOf(item.person);
    await store.reorderQueue(planMove(queue, itemId, target));
  };

  return {
    hasRoom,
    backingOff,
    getWindows,
    pauseBlock,
    usageBlock,
    guardTripped,
    openRun,
    blockItem,
    queuedOf,
    applyMove,
  };
}
