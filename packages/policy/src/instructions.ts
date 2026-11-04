import {
  openSubTickets,
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
  "requester",
  "blocker",
  "checks",
  "closer",
  "closed",
  "closed.at",
  "parent",
  "parent.open",
  "parent.closed",
] as const;

const isCause = (v: unknown): v is MergeCause =>
  typeof v === "object" && v !== null && "pr" in v && "title" in v;

const number = (pr: PrRef) => String(pr.number);

const stringOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** The checks a `pr.merge_checks_failed` names, by name, with their links. */
function checksOf(failing: unknown): string {
  const list = Array.isArray(failing) ? (failing as { name?: unknown; url?: unknown }[]) : [];
  return list
    .filter((c) => typeof c?.name === "string")
    .map((c) => (typeof c.url === "string" ? `${String(c.name)} (${c.url})` : String(c.name)))
    .join(", ");
}

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

/** Who closed the ticket a `ticket.closed` or `ticket.unblocked` names, from its `closedBy`; `someone` when unknown. */
function closerOf(by: unknown): string {
  const id = (by as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" ? id : "someone";
}

/** How a `ticket.closed` closed its ticket, and when, as `HH:MM UTC`; empty for any other event. */
function closedVariables(type: string, data: Record<string, unknown>): Record<string, string> {
  if (type !== "ticket.closed") {
    return { closed: "", "closed.at": "" };
  }

  const time = /T(\d\d:\d\d)/.exec(stringOf(data["at"]))?.[1];
  return {
    closed: data["status"] === "canceled" ? "canceled" : "closed as done",
    "closed.at": time ? `${time} UTC` : "an unknown time",
  };
}

const CLOSED = new Set(["done", "canceled"]);

/** The parent of the event's ticket, and the parent's sub-tickets still open and closed; empty without a parent. */
function parentVariables({ ticket, state }: EvaluationContext): Record<string, string> {
  const parent = ticket ? state.parentOf(ticket) : undefined;
  const closed = parent
    ? state.subTickets(parent).filter((t) => CLOSED.has(state.ticketStatus(t) ?? ""))
    : [];

  return {
    parent: parent ?? "",
    "parent.open": parent ? openSubTickets(state, parent).join(", ") : "",
    "parent.closed": closed.join(", "),
  };
}

/** The human who asked for the ticket's work, else the team's first human, as a hand-back assigns it. */
const requesterOf = ({ ticket, state, opts }: EvaluationContext): string =>
  (ticket ? state.requester(ticket) : undefined) ?? opts.fallbackRequester ?? "";

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
    requester: requesterOf(ctx),
    blocker: stringOf(event.data["blocker"]),
    checks: checksOf(event.data["failing"]),
    closer: closerOf(event.data["closedBy"]),
    ...closedVariables(event.type, event.data),
    ...parentVariables(ctx),
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
