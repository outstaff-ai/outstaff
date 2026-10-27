import {
  renderTemplate,
  TEMPLATE_VARIABLES,
  type TemplateError,
  templatePlaceholders,
  templateVariables,
  type EvaluationContext,
  type PrRef,
} from "@outstaff/core";
import type { MergeCause } from "./events.types.js";

/** What a pull request event says is wrong with the pull request, for the `pr.problem` variable. */
const PROBLEMS: Record<string, string> = {
  "pr.conflicted": "conflicts with its base branch",
  "pr.behind_base": "is behind its base branch, and the repository requires it to be up to date",
  "pr.base_merged": "is stacked on a branch that was just merged",
  "pr.ci_failed": "has failing checks",
};

/** Variables an instruction may use on top of the workflow templates' ones. */
export const INSTRUCTION_VARIABLES = [
  ...TEMPLATE_VARIABLES,
  "person",
  "doc.title",
  "pr.problem",
  "cause",
  "cause.number",
  "cause.title",
  "next.ticket",
] as const;

const isCause = (v: unknown): v is MergeCause =>
  typeof v === "object" && v !== null && "pr" in v && "title" in v;

const number = (pr: PrRef) => String(pr.number);

/** Every instruction variable for an event, unavailable ones empty. */
export function instructionVariables(
  ctx: EvaluationContext,
  extra: { person?: string; next?: string },
): Record<string, string> {
  const { event } = ctx;
  const cause = isCause(event.data["cause"]) ? event.data["cause"] : undefined;
  const title = event.data["title"];
  return {
    ...templateVariables(ctx),
    person: extra.person ?? "",
    "doc.title": typeof title === "string" ? title : (event.subject.doc ?? ""),
    "pr.problem": PROBLEMS[event.type] ?? "",
    cause: cause ? ` after #${number(cause.pr)} (${cause.title}) merged` : "",
    "cause.number": cause ? number(cause.pr) : "",
    "cause.title": cause?.title ?? "",
    "next.ticket": extra.next ?? "",
  };
}

/** Renders an instruction; throws a TemplateError on an unknown variable or a malformed placeholder. */
export const renderInstruction = (text: string, vars: Readonly<Record<string, string>>): string =>
  renderTemplate(text, vars).trim();

/** Why an instruction template cannot be used, or undefined when it can. */
export function instructionProblem(text: string): string | undefined {
  let names: string[];
  try {
    names = templatePlaceholders(text);
  } catch (error) {
    return (error as TemplateError).message;
  }

  const known = new Set<string>(INSTRUCTION_VARIABLES);
  const unknown = names.filter((n) => !known.has(n));
  return unknown.length > 0 ? `unknown variable ${unknown.join(", ")}` : undefined;
}
