import type { Check, PullRequest, WorkflowEvent } from "@outstaff/core";
import type { MergeCheckOps, RefreshCtx, WorkstateCore } from "./core.types.js";
import { recordSynthetic, WORKSTATE_ACTOR } from "./synthetic.js";
import type { MergeCheck, MergeChecks, PrRecord } from "./types.js";

const MINUTE = 60_000;
const DEFAULT_WAIT_MINUTES = 5;
const DEFAULT_TIMEOUT_MINUTES = 120;
const DEFAULT_SETTLE_MINUTES = 2;

/** How long a merge waits for its first check, for its last one to finish, and for no new one to appear. */
interface Waits {
  startMs: number;
  timeoutMs: number;
  settleMs: number;
}

/** What the checks on a merge commit decide, if anything yet. */
type Decision = Pick<MergeChecks, "state" | "failing" | "timedOut">;

/** Every check seen finished without failing: the merge passes once no new one appears for a while. */
interface Quiet {
  state: "quiet";

  /** The checks seen, by name, sorted. */
  checks: string[];
}

const toMergeCheck = (c: Check): MergeCheck => ({
  name: c.name,
  url: c.url,
  ...(c.logId ? { logId: c.logId } : {}),
});

/**
 * A failed or cancelled check fails the merge at once; a check still running waits, until the timeout fails it; no
 * check at all waits for one to start, then passes; checks that all finished otherwise (skipped and neutral too) are
 * quiet, and pass once no new check appears for the settle time.
 */
export function decideMergeChecks(
  checks: Check[],
  elapsedMs: number,
  waits: Pick<Waits, "startMs" | "timeoutMs">,
): Decision | Quiet | undefined {
  const failed = checks.filter((c) => c.status === "failure");
  if (failed.length > 0) {
    return { state: "failed", failing: failed.map(toMergeCheck) };
  }

  const running = checks.filter((c) => c.status === "pending");
  if (running.length > 0) {
    return elapsedMs >= waits.timeoutMs
      ? { state: "failed", failing: running.map(toMergeCheck), timedOut: true }
      : undefined;
  }

  if (checks.length === 0) {
    return elapsedMs < waits.startMs ? undefined : { state: "passed" };
  }

  return { state: "quiet", checks: checks.map((c) => c.name).toSorted() };
}

/** The default branch of the pull request's repository, as the team file says. */
function defaultBranchOf(core: WorkstateCore, rec: PrRecord): string {
  const i = core.repos.findIndex((r) => core.sameRepo(r, rec.ref.repo));
  return (i >= 0 ? core.team.repos[i]?.default_branch : undefined) ?? "main";
}

/**
 * The checks of a merge start to be followed when the office sees a pull request turn merged into the default
 * branch: one it had as open, or one a `pr.merged` names (`merged`). One it first sees merged otherwise was merged
 * before it watched.
 */
export function startMergeChecks(
  core: WorkstateCore,
  rec: PrRecord,
  prev: PrRecord | undefined,
  pr: Pick<PullRequest, "mergeCommitSha">,
  o: { now: string; merged?: boolean | undefined },
): PrRecord {
  const turned = rec.state === "merged" && (prev?.state === "open" || o.merged === true);
  if (rec.mergeChecks || !turned || rec.baseRef !== defaultBranchOf(core, rec)) {
    return rec;
  }

  const sha = pr.mergeCommitSha;
  return { ...rec, mergeChecks: { ...(sha ? { sha } : {}), since: o.now, state: "pending" } };
}

/** What a `pr.merge_checks_passed` or `pr.merge_checks_failed` carries. */
function mergeEventData(rec: PrRecord, checks: MergeChecks, at: string): Record<string, unknown> {
  const failing = (checks.failing ?? []).map(({ name, url }) => ({
    name,
    ...(url ? { url } : {}),
  }));

  return {
    ...(checks.sha ? { sha: checks.sha } : {}),
    base: rec.baseRef,
    ...(checks.state === "failed" ? { failing } : {}),
    ...(checks.timedOut ? { timedOut: true } : {}),
    ...(rec.url ? { url: rec.url } : {}),
    at,
  };
}

/** Follows the merges whose checks are not decided yet: from the store, so across restarts too. */
export function createMergeChecks(core: WorkstateCore): MergeCheckOps {
  const { store, vcs, clock, logger, prs, prSubject, team } = core;

  const waits = (): Waits => {
    const settings = team.policies?.merge_checks;
    return {
      startMs: (settings?.wait_for_start_minutes ?? DEFAULT_WAIT_MINUTES) * MINUTE,
      timeoutMs: (settings?.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES) * MINUTE,
      settleMs: (settings?.settle_minutes ?? DEFAULT_SETTLE_MINUTES) * MINUTE,
    };
  };

  const raise = async (ctx: RefreshCtx, rec: PrRecord, checks: MergeChecks) => {
    const type = checks.state === "passed" ? "pr.merge_checks_passed" : "pr.merge_checks_failed";
    const event: WorkflowEvent = {
      type,
      subject: { pr: rec.ref, ...(rec.ticket ? { ticket: rec.ticket } : {}) },
      actor: { ...WORKSTATE_ACTOR },
      data: mergeEventData(rec, checks, clock.now().toISOString()),
    };

    const once = `${type}:${prSubject(rec.ref)}:${checks.sha ?? "merged"}`;
    await recordSynthetic(store, ctx, event, once);
  };

  /** The checks on the merge commit, or undefined when they could not be read this time. */
  const read = async (rec: PrRecord, sha: string): Promise<Check[] | undefined> => {
    try {
      return await vcs.checks(rec.ref.repo, sha);
    } catch (error) {
      logger.warn("could not read the checks on a merge commit", {
        pr: prSubject(rec.ref),
        sha,
        error: String(error),
      });

      return undefined;
    }
  };

  const save = async (rec: PrRecord, mergeChecks: MergeChecks) => {
    const key = prSubject(rec.ref);
    const updated: PrRecord = { ...rec, mergeChecks, updatedAt: clock.now().toISOString() };
    prs.set(key, updated);
    await store.upsertSubject("pr", key, updated);
    return updated;
  };

  const decide = async (ctx: RefreshCtx, rec: PrRecord, pending: MergeChecks, d: Decision) => {
    const { quiet: _quiet, ...rest } = pending;
    const mergeChecks: MergeChecks = { ...rest, ...d };
    await raise(ctx, { ...rec, mergeChecks }, mergeChecks);
    await save(rec, mergeChecks);
  };

  /** The checks seen are quiet: pass once the same ones have been quiet for the settle time, else start counting. */
  const settle = async (ctx: RefreshCtx, rec: PrRecord, pending: MergeChecks, quiet: Quiet) => {
    const now = clock.now();
    const same = pending.quiet?.checks.join("\n") === quiet.checks.join("\n");
    const since = same ? Date.parse(pending.quiet!.since) : now.getTime();
    if (now.getTime() - since >= waits().settleMs) {
      await decide(ctx, rec, pending, { state: "passed" });
    } else if (!same) {
      await save(rec, { ...pending, quiet: { since: now.toISOString(), checks: quiet.checks } });
    }
  };

  const follow = async (ctx: RefreshCtx, rec: PrRecord, pending: MergeChecks) => {
    const checks = pending.sha ? await read(rec, pending.sha) : [];
    if (!checks) {
      return;
    }

    const elapsed = clock.now().getTime() - Date.parse(pending.since);
    const outcome = pending.sha
      ? decideMergeChecks(checks, elapsed, waits())
      : ({ state: "passed" } as const);

    if (outcome?.state === "quiet") {
      await settle(ctx, rec, pending, outcome);
    } else if (outcome) {
      await decide(ctx, rec, pending, outcome);
    } else if (pending.quiet) {
      // A check started again, or a new one: the quiet is over.
      const { quiet: _quiet, ...rest } = pending;
      await save(rec, rest);
    }
  };

  return {
    async followMerges(ctx) {
      for (const rec of prs.values()) {
        if (rec.mergeChecks?.state === "pending" && !rec.goneAt) {
          await follow(ctx, rec, rec.mergeChecks);
        }
      }
    },
  };
}
