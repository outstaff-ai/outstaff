export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Variables an instruction may use. All are always provided; unavailable ones render empty. */
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
