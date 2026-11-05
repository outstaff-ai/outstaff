import type { Run, WorkItem } from "#/store/types.js";
import type { Checks, ChecksOptions } from "./checks.types.js";
import {
  CHAT_KIND,
  HOUR_MS,
  isLoopGuarded,
  loopGuardVerdict,
  mergeRepo,
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
  const { store, team, clock, log, usage, maxRuns, chatSessions, stopped } = opts;

  /** The active merge of another item in the item's repository, if there is one. */
  const mergeRunning = async (item: Pick<WorkItem, "id" | "kind" | "subject">) => {
    const repo = mergeRepo(item);
    if (!repo) {
      return undefined;
    }

    const active = await store.listItems({ status: "active" });
    return active.find((i) => i.id !== item.id && mergeRepo(i) === repo);
  };

  /**
   * The chat session that filed the item, while it still runs: the work it files waits for it to end, so the tickets of
   * one request join one round instead of the first starting while the session files the rest.
   */
  const filingSession = async (item: Pick<WorkItem, "kind" | "parentId">) => {
    if (item.kind === CHAT_KIND || !item.parentId) {
      return undefined;
    }

    const parent = await store.getItem(item.parentId);
    return parent?.kind === CHAT_KIND && parent.status === "active" ? parent : undefined;
  };

  const hasRoom = async (
    item: Pick<WorkItem, "id" | "person" | "kind" | "subject" | "parentId">,
  ) => {
    const active = await store.listItems({ person: item.person, status: "active" });
    if (item.kind === CHAT_KIND) {
      return active.filter((i) => i.kind === CHAT_KIND).length < chatSessions;
    }

    return (
      !active.some((i) => i.kind !== CHAT_KIND) &&
      !(await mergeRunning(item)) &&
      !(await filingSession(item))
    );
  };

  /** Why the person has no room for the item: a full lane, its chat session still running, or another merge running. */
  const busyDetail = async (item: WorkItem): Promise<string> => {
    if (item.kind === CHAT_KIND) {
      return `${item.person} already runs ${chatSessions} chat sessions.`;
    }

    const own = await store.listItems({ person: item.person, status: "active" });
    const idle = !own.some((i) => i.kind !== CHAT_KIND);
    if (idle && (await filingSession(item))) {
      return "The chat session that filed it is still running; it starts once that session ends.";
    }

    const merging = idle ? await mergeRunning(item) : undefined;
    return merging
      ? `${merging.person} is merging in the same repository (${merging.subject!.ref}); one merge runs per repository at a time.`
      : `${item.person} already has an active item.`;
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

  const stop = async (item: WorkItem): Promise<string | undefined> => {
    const why = await stopped?.(item);
    if (why) {
      await store.updateItem(item.id, { status: "canceled" });
      await store.appendJournal(item.id, "scheduler", why);
      log.info("work item canceled at its start", { item: item.id, person: item.person, why });
    }

    return why;
  };

  return {
    hasRoom,
    busyDetail,
    mergeRunning,
    backingOff,
    getWindows,
    pauseBlock,
    usageBlock,
    guardTripped,
    openRun,
    blockItem,
    queuedOf,
    applyMove,
    stop,
  };
}
