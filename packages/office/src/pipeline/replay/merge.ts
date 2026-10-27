import type { WorkflowPr } from "@outstaff/core";
import { prLabel } from "../../log.js";
import { derivedId, deriveAfterMerge, sameRepo } from "../derive.js";
import type { PrSnapshot } from "../derive.types.js";
import type { PipelineEvent } from "../events.types.js";
import type { Derived, ReplayStep } from "./replay.types.js";

const snapshots = (step: ReplayStep, mergeable: Record<number, "clean" | "conflicting"> = {}) =>
  step.world.prs!.map((p: WorkflowPr): PrSnapshot => ({
    ref: p.ref,
    title: p.title,
    ...(p.url ? { url: p.url } : {}),
    headRef: p.headRef,
    baseRef: p.baseRef,
    state: p.state,
    mergeable: mergeable[p.ref.number] ?? "clean",
    ...(step.world.links?.[p.ref.number] ? { ticket: step.world.links[p.ref.number] } : {}),
  }));

/**
 * What today's work state raises after a merge: `pr.conflicted` for each other open pull request of the repository
 * that turned conflicting in the re-check (workstate.ts raises it only on a change into conflicting).
 */
function today(merged: PrSnapshot, before: PrSnapshot[], after: PrSnapshot[], at: string) {
  const was = new Map(before.map((p) => [prLabel(p.ref), p.mergeable]));
  return after
    .filter(
      (p) =>
        p.state === "open" &&
        sameRepo(p, merged) &&
        p.mergeable === "conflicting" &&
        was.get(prLabel(p.ref)) !== "conflicting",
    )
    .map((p): PipelineEvent => ({
      id: derivedId("pr.conflicted", p, merged),
      type: "pr.conflicted",
      at,
      subject: { pr: p.ref, ...(p.ticket ? { ticket: p.ticket } : {}) },
      actor: { kind: "automation", id: "workstate" },
      data: { base: p.baseRef },
    }));
}

/** The events a merge step raises on each side, the pipeline's first, then those only today raises. */
export function derivedEvents(step: ReplayStep): Derived[] {
  const merge = step.merge!;
  const before = snapshots(step, merge.before);
  const after = snapshots(step, merge.after);
  const merged = after.find((p) => prLabel(p.ref) === prLabel(step.event.subject.pr!))!;
  const now = deriveAfterMerge({
    merged,
    before,
    after,
    requiresUpToDate: merge.requiresUpToDate ?? false,
    at: step.event.at,
  });

  const old = today(merged, before, after, step.event.at);
  const oldIds = new Set(old.map((e) => e.id));
  const newIds = new Set(now.map((e) => e.id));
  return [
    ...now.map((event) => ({ event, today: oldIds.has(event.id), pipeline: true })),
    ...old
      .filter((e) => !newIds.has(e.id))
      .map((event) => ({ event, today: true, pipeline: false })),
  ];
}
