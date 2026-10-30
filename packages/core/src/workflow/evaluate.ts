import { check } from "./evaluate-check.js";
import { person } from "./evaluate-person.js";
import type { Ctx } from "./evaluate.types.js";
import { variables } from "./template-variables.js";
import type { ConditionEvent, WorkflowOptions, WorkflowState } from "./types.js";

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

/** The agent a policy's person reference names (`author`, `assignee`, `mentioned`, `role:<role>` ...), or why there is none. */
export const resolvePerson = person;

/** The template variables of an event (TEMPLATE_VARIABLES), every one present. */
export const templateVariables = variables;
