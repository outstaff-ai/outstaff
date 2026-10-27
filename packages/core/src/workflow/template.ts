export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Variables a workflow template may use. All are always provided; unavailable ones render empty. */
export const TEMPLATE_VARIABLES = [
  "ticket",
  "status",
  "actor.id",
  "actor.kind",
  "event.type",
  "pr.number",
  "pr.title",
  "pr.url",
  "pr.repo",
  "pr.base",
  "pr.head",
  "pr.author",
  "stack",
  "stack.count",
  "ticket.prs",
  "ticket.prs.count",
] as const;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g;

/** Names used by a template. Throws on a stray `{{` or `}}`. */
export function templatePlaceholders(text: string): string[] {
  const names: string[] = [];
  const rest = text.replace(PLACEHOLDER, (_m, name: string) => {
    names.push(name);
    return "";
  });

  if (rest.includes("{{") || rest.includes("}}")) {
    throw new TemplateError("Malformed placeholder; use {{name}}.");
  }

  return names;
}

/** Strict: an unknown variable is an error, never an empty string. */
export function renderTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  templatePlaceholders(text);
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      throw new TemplateError(`Unknown template variable "${name}".`);
    }

    return v;
  });
}

export const BUILTIN_TEMPLATES: Readonly<Record<string, string>> = {
  second_pr: [
    "{{ticket}} now has {{ticket.prs.count}} pull requests:",
    "",
    "{{ticket.prs}}",
    "",
    "outstaff moves a ticket to done when its last open pull request merges into the default branch, so the last of these to merge closes {{ticket}}. If the work needs several pull requests, split it into sub-tickets, one pull request each.",
  ].join("\n"),
  second_pr_many: [
    "{{ticket}} now has {{ticket.prs.count}} pull requests:",
    "",
    "{{ticket.prs}}",
    "",
    "This team allows several pull requests per ticket. outstaff moves {{ticket}} to done only when the agent has handed its work back as done and every one of them is closed with at least one merged; a merge alone does not close it.",
  ].join("\n"),
  rebase_conflict: [
    "Pull request #{{pr.number}} ({{pr.title}}) now conflicts with `{{pr.base}}`.",
    "",
    "Rebase it onto the latest `{{pr.base}}` and push:",
    "",
    "    git fetch origin",
    "    git rebase origin/{{pr.base}}",
    "    git push --force-with-lease",
    "",
    "Stack, bottom first ({{stack.count}}):",
    "{{stack}}",
    "",
    "Rebase from the bottom up. After each push, retarget the next pull request onto the one below it if its base was merged.",
    "",
    "Keep the description of each pull request current: after the push it must still describe what the branch does now. If the approach changed, comment on the pull request with what changed, which merge caused it and why.",
  ].join("\n"),
};
