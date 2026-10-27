import type { Effect } from "@outstaff/core";
import type { EffectOutcome } from "#/engine/types.js";
import { prLabel } from "#/log.js";
import type { Decision } from "#/pipeline/decisions.types.js";
import type { EngineRecord, Outcome } from "./compare.types.js";

/** Kinds the pipeline renamed. */
export const KIND_ALIASES: Record<string, string> = { conflict: "rebase" };

/** A schedule's subject: its pull request, else its ticket, else its document. */
function scheduleSubject(e: Extract<Effect, { type: "schedule" }>) {
  if (e.pr) {
    return { type: "pr", ref: prLabel(e.pr) };
  }

  if (e.ticket) {
    return { type: "ticket", ref: e.ticket };
  }

  return e.doc ? { type: "doc", ref: e.doc } : undefined;
}

const commentTarget = (on: Extract<Effect, { type: "comment" }>["on"]) =>
  "ticket" in on ? on.ticket : prLabel(on.pr);

/** One engine effect as an outcome. */
export function fromEffect(e: Effect): Outcome {
  switch (e.type) {
    case "schedule":
      return {
        type: "wake",
        person: e.person,
        kind: KIND_ALIASES[e.kind] ?? e.kind,
        subject: scheduleSubject(e),
      };
    case "move":
      return { type: "move", ticket: e.ticket, to: e.to, as: "office" };
    case "assign":
      return { type: "assign", ticket: e.ticket, to: e.to, as: "office" };
    case "comment":
      return { type: "comment", on: commentTarget(e.on), as: "office" };
  }
}

/** The pipeline's wakes and acts as outcomes; drops do nothing. */
export function fromDecisions(decisions: readonly Decision[]): Outcome[] {
  return decisions.flatMap((d): Outcome[] => {
    if (d.type === "wake") {
      return [
        { type: "wake", person: d.person, kind: d.kind, subject: d.subject, policy: d.policy },
      ];
    }

    if (d.type === "drop") {
      return [];
    }

    return d.ops.map((op): Outcome => {
      const base = { as: d.as, policy: d.policy };
      switch (op.op) {
        case "move":
          return { type: "move", ticket: op.ticket, to: op.to, ...base };
        case "assign":
          return { type: "assign", ticket: op.ticket, to: op.to, ...base };
        case "comment":
          return { type: "comment", on: "ticket" in op.on ? op.on.ticket : op.on.doc, ...base };
        case "set_parent":
          return { type: "set_parent", ticket: op.ticket, parent: op.parent, ...base };
      }
    });
  });
}

/**
 * A schedule the engine skipped because the person already has that work queued, running or retried: the run exists,
 * as it would after the pipeline's wake joined it.
 */
const runExists = (o: EffectOutcome) =>
  o.status === "skipped" && o.effect.type === "schedule" && o.note.startsWith("work item ");

const noted = (list: EffectOutcome[]) =>
  list.map((o) => ({ outcome: fromEffect(o.effect), note: o.note }));

/** What the engine did for an event, from the outcomes it returned. */
export function engineRecord(outcomes: readonly EffectOutcome[]): EngineRecord {
  const done = outcomes.filter((o) => o.status === "applied" || runExists(o));
  const skipped = outcomes.filter((o) => o.status === "skipped" && !runExists(o));
  const failed = outcomes.filter((o) => o.status === "failed");
  return {
    effects: done.map((o) => fromEffect(o.effect)),
    ...(skipped.length ? { skipped: noted(skipped) } : {}),
    ...(failed.length ? { failed: noted(failed) } : {}),
  };
}
