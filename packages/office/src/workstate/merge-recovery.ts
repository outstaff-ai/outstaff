import type { Check } from "@outstaff/core";
import { recoveryLine, workGoesOn } from "./block-nudges.js";
import type { RecoveryDeps } from "./merge-recovery.types.js";
import type { RefreshCtx, WorkstateCore } from "./core.types.js";
import { isTerminal } from "./derive.js";
import type { MergeCheck, MergeChecks, PrRecord } from "./types.js";

/** The same check on another commit: the same name, and the same workflow when both name one. */
const same = (failed: MergeCheck, c: Check) =>
  c.name === failed.name && (!failed.workflow || !c.workflow || failed.workflow === c.workflow);

/**
 * What a later commit's checks make of the checks that failed on the merge commit: every one passed there; one still
 * runs there (look again); or one failed or did not run there.
 */
export function recoveredBy(failing: readonly MergeCheck[], checks: readonly Check[]) {
  const of = (f: MergeCheck) => checks.filter((c) => same(f, c));
  const passed = (f: MergeCheck) => {
    const runs = of(f);
    return runs.length > 0 && runs.every((c) => c.status === "success");
  };

  if (failing.every(passed)) {
    return "passed";
  }

  const settled = (f: MergeCheck) => passed(f) || of(f).every((c) => c.status !== "pending");
  return failing.every(settled) ? "not" : "running";
}

/** A failed merge with a commit, not made up for yet. */
const unrecovered = (m: MergeChecks | undefined): m is MergeChecks =>
  m?.state === "failed" && !!m.sha && !m.recoveredOn;

/** A failed merge into the default branch whose ticket is still open: a later commit may make up for it. */
function followed(
  core: WorkstateCore,
  rec: PrRecord,
): rec is PrRecord & { mergeChecks: MergeChecks } {
  const ticket = rec.ticket ? core.tickets.get(rec.ticket) : undefined;
  return unrecovered(rec.mergeChecks) && !rec.goneAt && !!rec.ticket && !isTerminal(ticket?.status);
}

/**
 * Follows failed merges on the default branch: once every check that failed on the merge commit passes on the
 * branch's head, and the head contains the merge commit, the merge passed after all (`recoveredOn`). Only the head is
 * looked at, once per head, and only while the merge's ticket is open.
 */
export function createMergeRecovery(core: WorkstateCore, deps: RecoveryDeps) {
  const { vcs, logger, prSubject } = core;

  const attempt = async <T>(what: string, rec: PrRecord, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      logger.warn(`could not read ${what}`, { pr: prSubject(rec.ref), error: String(error) });
      return undefined;
    }
  };

  const headOf = (rec: PrRecord, heads: Map<string, Promise<string | undefined>>) => {
    const key = `${prSubject({ ...rec.ref, number: 0 })}@${rec.baseRef}`;
    if (!heads.has(key)) {
      heads.set(
        key,
        attempt("the head of the default branch", rec, () =>
          vcs.branchHead!(rec.ref.repo, rec.baseRef),
        ),
      );
    }

    return heads.get(key)!;
  };

  const recover = async (ctx: RefreshCtx, rec: PrRecord, m: MergeChecks, head: string) => {
    const checks = await deps.read(rec, head);
    const outcome = checks ? recoveredBy(m.failing ?? [], checks) : "running";
    if (outcome === "running") {
      return;
    }

    const contains =
      outcome === "passed" &&
      (await attempt("whether the default branch contains a merge", rec, () =>
        vcs.contains!(rec.ref.repo, head, m.sha!),
      ));

    if (contains === undefined) {
      return;
    }

    if (!contains) {
      await deps.save(rec, { ...m, seenHead: head });
      return;
    }

    await deps.decide(ctx, rec, m, { state: "passed", recoveredOn: head });
    await nudgeIfOpen(ctx, core.prs.get(prSubject(rec.ref))!);
  };

  /** The merge passing closes its ticket unless the ticket's work goes on: then the PM looks at its block. */
  const nudgeIfOpen = async (ctx: RefreshCtx, rec: PrRecord) => {
    if (workGoesOn(core, rec.ticket!)) {
      const names = (rec.mergeChecks?.failing ?? []).map((c) => c.name).join(", ");
      await deps.nudges.nudge(ctx, rec.ticket!, {
        kind: "check",
        ref: names,
        why: recoveryLine(rec),
      });
    }
  };

  return {
    async followRecoveries(ctx: RefreshCtx) {
      if (!vcs.branchHead || !vcs.contains) {
        return;
      }

      const heads = new Map<string, Promise<string | undefined>>();
      for (const rec of core.prs.values()) {
        if (followed(core, rec)) {
          const head = await headOf(rec, heads);
          const m = rec.mergeChecks;
          if (head && head !== m.sha && head !== m.seenHead) {
            await recover(ctx, rec, m, head);
          }
        }
      }
    },
  };
}
