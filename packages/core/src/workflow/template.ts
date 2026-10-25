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
  hand_back_blocked:
    "{{ticket}} is blocked: the agent could not continue. Its last comment on the ticket says what is needed; the work so far is kept on its branch.",
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
  ].join("\n"),
};
