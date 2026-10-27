import type { ConditionCheck, EvaluationContext } from "./types.js";

export type Ctx = EvaluationContext;

export type Check = ConditionCheck;

export type Resolved<T> = { value: T } | { skip: string };
