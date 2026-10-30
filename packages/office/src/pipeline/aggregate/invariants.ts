import { BOOKKEEPING_OPS, type ActProposal, type WakeProposal } from "@outstaff/policy";
import type { AggregateInput, Slot } from "./aggregate.types.js";

/** Events the office raises for an agent, about the agent: an idle agent's pull is woken for its own "action". */
const FOR_THE_AGENT = new Set(["agent.idle"]);

/**
 * The office's own automation, whose events may wake: the merge re-check (`office`, in `pipeline/derive.ts`) and the
 * work state's conflict and CI checks (`workstate`, in `workstate/prs.ts`). A new source of synthetic events adds its
 * actor here, or the loop guard drops its wakes.
 */
const OFFICE_ACTORS = new Set(["office", "workstate"]);

const BOOKKEEPING: ReadonlySet<string> = new Set(BOOKKEEPING_OPS);

function wakeViolation(p: WakeProposal, { event, options }: AggregateInput): string | undefined {
  if (!options.people.includes(p.person)) {
    return `${p.person} is not an agent on the team`;
  }

  const { actor } = event;
  if (actor.kind === "agent" && actor.id === p.person && !FOR_THE_AGENT.has(event.type)) {
    return `never wake an agent for its own action: ${p.person} caused the event`;
  }

  return actor.kind === "automation" && !OFFICE_ACTORS.has(actor.id)
    ? `loop guard: an event a bot (${actor.id}) caused wakes no one`
    : undefined;
}

function actViolation(
  p: ActProposal,
  { options }: AggregateInput,
  acted: Set<string>,
  policy: string,
) {
  if (!options.people.includes(p.as)) {
    return `never act as the office: ${p.as} is not an agent on the team`;
  }

  const judgement = p.ops.find((o) => !BOOKKEEPING.has(o.op));
  if (judgement) {
    return `an act is bookkeeping only: ${judgement.op} is not one of ${BOOKKEEPING_OPS.join(", ")}; anything that needs judgement is a wake`;
  }

  return acted.has(policy)
    ? "one act per policy and event: return one act with every change"
    : undefined;
}

/** Which invariant a proposal breaks, if any; drops and errors break none. */
function violation(slot: Slot, input: AggregateInput, acted: Set<string>): string | undefined {
  const p = slot.proposal;
  switch (p.type) {
    case "wake":
      return wakeViolation(p, input);
    case "act":
      return actViolation(p, input, acted, slot.policy);
    case "suppress":
      return input.options.people.includes(p.person)
        ? undefined
        : `${p.person} is not an agent on the team`;
    default:
      return undefined;
  }
}

/**
 * The invariants every proposal is held to, whichever policy made it: never act as the office, never wake an agent for
 * its own action, the loop guard (a bot's event wakes no one), acts are bookkeeping only, one act per policy. A wake or
 * act that breaks one is rejected, and dropped with the reason.
 */
export function enforceInvariants(slots: readonly Slot[], input: AggregateInput): void {
  const acted = new Set<string>();
  for (const slot of slots) {
    const p = slot.proposal;
    const broken = violation(slot, input, acted);

    if (p.type === "act" && !broken) {
      acted.add(slot.policy);
    }

    if (broken) {
      slot.outcome = "rejected";
      slot.reason = broken;
      // A suppression decides nothing of its own: rejected, it is only traced.
      slot.decision =
        p.type === "suppress" ? undefined : { type: "drop", policy: slot.policy, reason: broken };
    }
  }
}
