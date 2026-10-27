import { parseDocument, stringify } from "yaml";
import { CATALOG_CODES, CatalogError } from "#/catalog/codes.js";

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/;

/**
 * Puts `name` and `description` at the top of a rendered skill so the runtime lists it as a skill.
 * A front matter block already in the source is kept (its other keys and its own `description`
 * survive; the role summary is only the fallback), but `name` is always the role's, so the skill
 * never ends up with two blocks or a name that differs from its directory. Expects LF text.
 */
export function withSkillFrontMatter(
  text: string,
  meta: { name: string; description: string },
  file: string,
): string {
  const { front, rest } = splitFrontMatter(text, file);
  const { name: _name, description: own, ...others } = front;
  const description =
    typeof own === "string" && own.trim()
      ? own.trim()
      : meta.description.replace(/\s+/g, " ").trim();

  const block = stringify({ name: meta.name, description, ...others }, { lineWidth: 0 });

  return `---\n${block}---\n\n${rest.replace(/^\n+/, "")}`;
}

/** The keys of the source's front matter block (none without one) and the text after it. */
function splitFrontMatter(
  text: string,
  file: string,
): { front: Record<string, unknown>; rest: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    return { front: {}, rest: text };
  }

  return { front: parseFrontMatter(match[1] ?? "", file), rest: text.slice(match[0].length) };
}

const isMapping = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

/** A front matter block must be a YAML mapping, or empty. */
function parseFrontMatter(yaml: string, file: string): Record<string, unknown> {
  const doc = parseDocument(yaml, { prettyErrors: false });
  const value: unknown = doc.toJS();
  if (doc.errors.length === 0 && (value === null || value === undefined || isMapping(value))) {
    return (value ?? {}) as Record<string, unknown>;
  }

  throw new CatalogError([
    {
      code: CATALOG_CODES.frontMatterInvalid,
      message: doc.errors[0]?.message ?? "Front matter must be a YAML mapping.",
      file,
      line: 1,
      column: 1,
    },
  ]);
}
