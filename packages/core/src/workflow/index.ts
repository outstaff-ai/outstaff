export { DEFAULT_NEEDS_HUMAN_LABEL, WORKFLOW_EVENT_TYPES } from "./constants.js";
export {
  TEMPLATE_VARIABLES,
  BUILTIN_TEMPLATES,
  TemplateError,
  renderTemplate,
  templatePlaceholders,
} from "./template.js";

export { createStatusMap } from "./status-map.js";
export { conditionSchema, actionSchema, ruleSchema, ruleInputSchema } from "./rules.js";
export {
  PRESET_MOVES_TICKETS,
  WORKFLOW_PRESETS,
  presetRules,
  type WorkflowPreset,
} from "./presets.js";

export {
  applySwitches,
  mergeRules,
  resolveWorkflow,
  type ResolvedWorkflow,
  type SwitchedRule,
} from "./resolve.js";

export { describeEffect } from "./describe.js";
export {
  checkCondition,
  createEvaluationContext,
  evaluateWorkflow,
  explainWorkflow,
  resolvePerson,
  templateVariables,
} from "./evaluate.js";

export type { Resolved } from "./evaluate.types.js";
export { createStaticWorkflowState } from "./state.js";
export type {
  ActorKind,
  Effect,
  EffectTarget,
  PrRef,
  PrVerdict,
  Priority,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowOptions,
  WorkflowPr,
  WorkflowState,
  WorkflowStatusMap,
  Condition,
  Action,
  Rule,
  RuleInput,
  RuleExplanation,
  WorkflowExplanation,
  StaticWorkflowData,
  StaticTicket,
  ConditionEvent,
  EvaluationContext,
  ConditionCheck,
} from "./types.js";
