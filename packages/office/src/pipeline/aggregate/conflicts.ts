import type { BookkeepingOp } from "@outstaff/policy";
import type { Act, ActOp } from "#/pipeline/decisions.types.js";
import { describeOp } from "#/pipeline/describe.js";
import type { Slot } from "./aggregate.types.js";

/** The ticket field an op sets. */
const FIELD: Record<string, string> = { move: "status", assign: "assignee", set_parent: "parent" };

/** Acts are bookkeeping only by now: the invariants rejected any other op. */
const fieldOf = (op: ActOp) => `${(op as BookkeepingOp).ticket} ${FIELD[op.op]}`;

const same = (a: ActOp, b: ActOp) => JSON.stringify(a) === JSON.stringify(b);

/** Highest priority first; on a tie, the policy listed first. */
const byPriority = (a: Slot, b: Slot) => b.priority - a.priority || a.order - b.order;

/**
 * Acts that set the same field of the same ticket: the change of the act with the higher priority is made, the other
 * dropped; the same change twice is made once. An act left with nothing to change is dropped, saying why.
 */
export function settleActs(slots: readonly Slot[]): void {
  const claimed = new Map<string, { slot: Slot; op: ActOp }>();
  const acts = slots.filter((s) => s.decision?.type === "act").toSorted(byPriority);
  for (const slot of acts) {
    const act = slot.decision as Act;
    const kept: ActOp[] = [];
    const lost: string[] = [];
    for (const op of act.ops) {
      const field = fieldOf(op);
      const holder = claimed.get(field);
      if (!holder) {
        claimed.set(field, { slot, op });
        kept.push(op);
      } else if (same(op, holder.op)) {
        lost.push(`${describeOp(op)}: already made by ${holder.slot.policy}`);
      } else {
        lost.push(`${describeOp(op)}: conflicts with ${holder.slot.policy}, which takes priority`);
      }
    }

    if (lost.length === 0) {
      continue;
    }

    slot.reason = lost.join("; ");
    if (kept.length === 0) {
      slot.outcome = "dropped";
      slot.decision = { type: "drop", policy: slot.policy, reason: slot.reason };
    } else {
      act.ops = kept;
    }
  }
}
