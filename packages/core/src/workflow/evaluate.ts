import { check } from "./evaluate-check.js";
import { performAll, person } from "./evaluate-actions.js";
import type { Ctx } from "./evaluate.types.js";
import { variables } from "./template-variables.js";
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
  const explained = rules.map((rule) => explainRule(rule, ctx));

  return { event, rules: explained, effects: distinct(explained.flatMap((r) => r.effects)) };
}

function explainRule(rule: Rule, ctx: Ctx): RuleExplanation {
  const types: readonly string[] = Array.isArray(rule.on) ? rule.on : [rule.on];
  if (!types.includes(ctx.event.type)) {
    return unmatched(rule, `listens to ${types.join(", ")}, not ${ctx.event.type}`);
  }

  const c = rule.if ? check(rule.if, ctx) : { ok: true, detail: "no condition" };
  if (!c.ok) {
    return unmatched(rule, c.detail);
  }

  const effects: Effect[] = [];
  const skipped: string[] = [];
  for (const action of rule.do) {
    const r = performAll(action, ctx);
    if ("skip" in r) {
      skipped.push(`${Object.keys(action)[0]}: ${r.skip}`);
    } else {
      effects.push(...r.value);
    }
  }

  return { id: rule.id, matched: true, reason: c.detail, effects, skipped };
}

const unmatched = (rule: Rule, reason: string): RuleExplanation => ({
  id: rule.id,
  matched: false,
  reason,
  effects: [],
  skipped: [],
});

/** The effects without repeats, first occurrence first. */
function distinct(effects: Effect[]): Effect[] {
  const seen = new Set<string>();

  return effects.filter((e) => {
    const k = stable(e);
    if (seen.has(k)) {
      return false;
    }

    seen.add(k);

    return true;
  });
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
