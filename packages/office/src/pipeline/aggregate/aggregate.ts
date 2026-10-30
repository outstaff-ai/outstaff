import type { Policy, PolicyRun } from "@outstaff/policy";
import type { Decision } from "#/pipeline/decisions.types.js";
import type { AggregationEntry } from "#/pipeline/trace.types.js";
import type { AggregateInput, Slot } from "./aggregate.types.js";
import { settleActs } from "./conflicts.js";
import { enforceInvariants } from "./invariants.js";
import { applySuppressions, mergeWakes, wakeOf } from "./wakes.js";

/** Every proposal of the event, in order: the policies in their order, each one's proposals in theirs. */
function slotsOf(runs: readonly PolicyRun[], priorities: ReadonlyMap<string, number>): Slot[] {
  let order = 0;
  return runs.flatMap((run) =>
    run.proposals.map((proposal, index) => ({
      policy: run.policy,
      index,
      order: order++,
      priority: priorities.get(run.policy)!,
      proposal,
    })),
  );
}

/** What each proposal is before the cross-policy rules: an error, a drop, a wake, an act, or a suppression (later). */
function initial(slot: Slot, input: AggregateInput): void {
  const p = slot.proposal;
  if (slot.outcome) {
    return;
  }

  switch (p.type) {
    case "error":
      slot.outcome = "error";
      slot.reason = p.reason;
      return;
    case "drop":
      slot.outcome = "kept";
      slot.decision = { type: "drop", policy: slot.policy, reason: p.reason };
      return;
    case "wake":
      wakeOf(slot, p, input);
      return;
    case "act":
      slot.outcome = "kept";
      slot.decision = {
        type: "act",
        policy: slot.policy,
        as: p.as,
        ops: [...p.ops],
        ...(p.note ? { note: p.note } : {}),
      };
  }
}

/** The decisions in the order they were proposed, and each proposal's entry pointing at its decision. */
function collect(slots: readonly Slot[]) {
  const decisions: Decision[] = [];
  const at = new Map<Slot, number>();
  for (const slot of slots) {
    if (slot.decision) {
      at.set(slot, decisions.length);
      decisions.push(slot.decision);
    }
  }

  const aggregation = slots.map((slot): AggregationEntry => {
    const decision = at.get(slot.into ?? slot);
    return {
      policy: slot.policy,
      proposal: slot.index,
      outcome: slot.outcome!,
      ...(slot.reason ? { reason: slot.reason } : {}),
      ...(decision === undefined ? {} : { decision }),
    };
  });

  return { decisions, aggregation };
}

/**
 * The aggregation layer: what the office does with an event, from every policy's proposals. The invariants are
 * enforced first; then suppressions beat wakes, acts on the same ticket field are settled by priority, and wakes for
 * the same person and subject are merged. Pure: the same proposals always give the same decisions.
 */
export function aggregate(
  runs: readonly PolicyRun[],
  policies: readonly Pick<Policy, "id" | "priority">[],
  input: AggregateInput,
): { decisions: Decision[]; aggregation: AggregationEntry[] } {
  const priorities = new Map(policies.map((p) => [p.id, p.priority ?? 0]));
  const slots = slotsOf(runs, priorities);
  enforceInvariants(slots, input);
  for (const slot of slots) {
    initial(slot, input);
  }

  applySuppressions(slots);
  settleActs(slots);
  mergeWakes(slots);
  const { decisions, aggregation } = collect(slots);
  if (decisions.length === 0) {
    const reason = runs.some((r) => r.matched)
      ? "no policy proposed anything"
      : "no policy matched";

    decisions.push({ type: "drop", reason });
  }

  return { decisions, aggregation };
}
