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

export { WORKFLOW_PRESETS, presetRules, type WorkflowPreset } from "./presets.js";
export { mergeRules, resolveWorkflow, type ResolvedWorkflow } from "./resolve.js";
export {
  evaluateWorkflow,
  explainWorkflow,
  type RuleExplanation,
  type WorkflowExplanation,
} from "./evaluate.js";

export { createStaticWorkflowState, type StaticWorkflowData, type StaticTicket } from "./state.js";
