import type { PipelineCondition } from "@outstaff/policy";

const code = (s: string) => `\`${s}\``;

const valueText = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v));

const COMBINATORS: Record<string, string> = { all: "all of:", any: "any of:", not: "not:" };

/** A condition as a nested Markdown list, one line per leaf and one per `all`, `any` or `not`. */
export function conditionLines(c: PipelineCondition, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const [key, value] = Object.entries(c)[0]!;
  const label = COMBINATORS[key];
  if (!label) {
    return [`${indent}- ${code(`${key}: ${valueText(value)}`)}`];
  }

  const children = (Array.isArray(value) ? value : [value]) as PipelineCondition[];
  return [`${indent}- ${label}`, ...children.flatMap((child) => conditionLines(child, depth + 1))];
}
