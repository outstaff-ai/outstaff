import type { z } from "zod";
import type { Policy, PolicyDefinition } from "./policy.types.js";
import type { Proposal } from "./proposal.types.js";
import { policySchema, proposalSchema } from "./schema.js";

const issues = (error: z.ZodError): string[] =>
  error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));

/** Why a value is not a policy, one line per problem; empty when it is one. */
export function policyProblems(value: unknown): string[] {
  const parsed = policySchema.safeParse(value);
  return parsed.success ? [] : issues(parsed.error);
}

/** Checks a policy and freezes it. Throws, listing every problem, when the definition is not a policy. */
export function definePolicy(definition: PolicyDefinition): Policy {
  const problems = policyProblems(definition);
  if (problems.length > 0) {
    const name = typeof definition?.id === "string" ? ` ${definition.id}` : "";
    throw new Error(`not a policy${name}: ${problems.join("; ")}`);
  }

  return Object.freeze({ ...definition });
}

/** The proposals a policy returned, checked: the list, or why it is not one. */
export function checkProposals(value: unknown): { value: Proposal[] } | { skip: string } {
  if (!Array.isArray(value)) {
    return { skip: "returned something other than a list of proposals" };
  }

  for (const [n, item] of value.entries()) {
    const parsed = proposalSchema.safeParse(item);
    if (!parsed.success) {
      return { skip: `returned a malformed proposal ${n}: ${issues(parsed.error).join("; ")}` };
    }
  }

  return { value: value as Proposal[] };
}
