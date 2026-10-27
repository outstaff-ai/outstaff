import type { Condition, ConditionCheck, EvaluationContext } from "./types.js";

export type Ctx = EvaluationContext;

export type Check = ConditionCheck;

export type Resolved<T> = { value: T } | { skip: string };

type KeysOf<T> = T extends unknown ? keyof T : never;

/** The name of a condition: the one key of its object (`ticket_status`, `pr_open`, ...). */
export type ConditionKey = KeysOf<Condition>;

/** What a condition of the given name asks for: the value under its key. */
export type ConditionValue<K extends ConditionKey> = Extract<Condition, Record<K, unknown>>[K];

/** How each condition is checked, from what it asks for. */
export type ConditionChecks = {
  [K in ConditionKey]: (wanted: ConditionValue<K>, ctx: Ctx) => Check;
};
