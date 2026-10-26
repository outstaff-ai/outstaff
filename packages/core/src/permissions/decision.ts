import type { Decision } from "./types.js";

export const allow = (reason: string, rule?: string): Decision => ({
  effect: "allow",
  reason,
  ...(rule ? { rule } : {}),
});

export const deny = (reason: string, rule?: string): Decision => ({
  effect: "deny",
  reason,
  ...(rule ? { rule } : {}),
});

/** Worst of: deny, allow. */
export function worst(decisions: Decision[]): Decision {
  return (
    decisions.find((d) => d.effect === "deny") ??
    decisions[decisions.length - 1] ??
    allow("Nothing to check.")
  );
}
