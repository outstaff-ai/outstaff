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

/** The variables that name the merge behind a derived event; empty for any other event. */
function causeVariables(data: Record<string, unknown>): Record<string, string> {
  const cause = data["cause"];
  if (!isCause(cause)) {
    return { cause: "", "cause.number": "", "cause.title": "" };
  }

  return {
    cause: ` after #${number(cause.pr)} (${cause.title}) merged`,
    "cause.number": number(cause.pr),
    "cause.title": cause.title,
  };
}

/** Every instruction variable for an event, unavailable ones empty. */
export function instructionVariables(
  ctx: EvaluationContext,
  extra: { person?: string | undefined; next?: string | undefined },
): Record<string, string> {
  const { event } = ctx;
  const title = event.data["title"];
  return {
    ...templateVariables(ctx),
    person: extra.person ?? "",
    "doc.title": typeof title === "string" ? title : (event.subject.doc ?? ""),
    "pr.problem": PROBLEMS[event.type] ?? "",
    ...causeVariables(event.data),
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
