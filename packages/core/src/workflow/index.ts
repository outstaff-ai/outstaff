export * from "./types.js";
export {
  TEMPLATE_VARIABLES,
  BUILTIN_TEMPLATES,
  TemplateError,
  renderTemplate,
  templatePlaceholders,
} from "./template.js";

export { createStatusMap, type WorkflowStatusMap } from "./status-map.js";
export {
  conditionSchema,
  actionSchema,
  ruleSchema,
  ruleInputSchema,
  type Condition,
  type Action,
  type Rule,
  type RuleInput,
} from "./rules.js";

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
  evaluateWorkflow,
  explainWorkflow,
  type RuleExplanation,
  type WorkflowExplanation,
} from "./evaluate.js";

export { createStaticWorkflowState, type StaticWorkflowData, type StaticTicket } from "./state.js";
