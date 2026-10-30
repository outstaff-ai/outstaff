import type { WorkflowPr } from "@outstaff/core";
import { prLabel } from "#/log.js";
import { deriveAfterMerge } from "#/pipeline/derive.js";
import type { PrSnapshot } from "#/pipeline/derive.types.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { ReplayStep } from "./replay.types.js";

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

/** The events a merge step raises for the repository's other open pull requests. */
export function derivedEvents(step: ReplayStep): PipelineEvent[] {
  const merge = step.merge!;
  const after = snapshots(step, merge.after);
  const merged = after.find((p) => prLabel(p.ref) === prLabel(step.event.subject.pr!))!;
  return deriveAfterMerge({
    merged,
    before: snapshots(step, merge.before),
    after,
    requirements: merge.requirements ?? { branch: merged.baseRef, upToDate: false },
    at: step.event.at,
  });
}
