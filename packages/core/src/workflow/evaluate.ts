import { check } from "./evaluate-check.js";
import { performAll, person, variables } from "./evaluate-actions.js";
import type { Ctx } from "./evaluate.types.js";
import type {
  ConditionEvent,
  Effect,
  Rule,
  RuleExplanation,
  WorkflowEvent,
  WorkflowExplanation,
  WorkflowOptions,
  WorkflowState,
} from "./types.js";

function stable(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(stable).join(",")}]`;
  }

  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }

  return JSON.stringify(v);
}

/** The ticket and pull request an event is about, looked up once, for checking conditions and resolving people. */
export function createEvaluationContext(
  event: ConditionEvent,
  state: WorkflowState,
  opts: WorkflowOptions = {},
): Ctx {
  const pr = event.subject.pr ? state.pullRequest(event.subject.pr) : undefined;
  const ticket =
    event.subject.ticket ?? (event.subject.pr ? state.ticketForPr(event.subject.pr) : undefined);

  return { event, state, opts, ticket, pr };
}

/** Whether a condition holds, and the detail of the first part that decided it. */
export const checkCondition = check;

/** The agent a schedule's `person` names (`author`, `assignee`, `mentioned`, `role:<role>` ...), or why there is none. */
export const resolvePerson = person;

/** The template variables of an event (TEMPLATE_VARIABLES), every one present. */
export const templateVariables = variables;

/** Which rules matched or did not, and why. Pure: the same inputs always give the same output. */
export function explainWorkflow(
  event: WorkflowEvent,
  state: WorkflowState,
  rules: readonly Rule[],
  opts: WorkflowOptions = {},
): WorkflowExplanation {
  const ctx = createEvaluationContext(event, state, opts);

  const out: RuleExplanation[] = [];
  const seen = new Set<string>();
  const effects: Effect[] = [];
  for (const rule of rules) {
    const types = Array.isArray(rule.on) ? rule.on : [rule.on];
    if (!types.includes(event.type)) {
      out.push({
        id: rule.id,
        matched: false,
        reason: `listens to ${types.join(", ")}, not ${event.type}`,
        effects: [],
        skipped: [],
      });

      continue;
    }

    const c = rule.if ? check(rule.if, ctx) : { ok: true, detail: "no condition" };
    if (!c.ok) {
      out.push({ id: rule.id, matched: false, reason: c.detail, effects: [], skipped: [] });
      continue;
    }

    const mine: Effect[] = [];
    const skipped: string[] = [];
    for (const action of rule.do) {
      const r = performAll(action, ctx);
      if ("skip" in r) {
        skipped.push(`${Object.keys(action)[0]}: ${r.skip}`);
      } else {
        mine.push(...r.value);
      }
    }

    out.push({ id: rule.id, matched: true, reason: c.detail, effects: mine, skipped });
    for (const e of mine) {
      const k = stable(e);
      if (seen.has(k)) {
        continue;
      }

      seen.add(k);
      effects.push(e);
    }
  }

  return { event, rules: out, effects };
}

/** Ordered, deduplicated effects for an event. */
export function evaluateWorkflow(
  event: WorkflowEvent,
  state: WorkflowState,
  rules: readonly Rule[],
  opts: WorkflowOptions = {},
): Effect[] {
  return explainWorkflow(event, state, rules, opts).effects;
}
