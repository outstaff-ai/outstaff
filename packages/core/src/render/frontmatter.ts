import { parseDocument, stringify } from "yaml";
import { CATALOG_CODES, CatalogError } from "../catalog/codes.js";

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
  const match = FRONT_MATTER.exec(text);
  let rest = text;
  let extra: Record<string, unknown> = {};
  if (match) {
    const doc = parseDocument(match[1] ?? "", { prettyErrors: false });
    const value: unknown = doc.toJS();
    const isMap = value !== null && typeof value === "object" && !Array.isArray(value);
    if (doc.errors.length || (value !== null && value !== undefined && !isMap)) {
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

    extra = (value as Record<string, unknown> | null) ?? {};
    rest = text.slice(match[0].length);
  }

  const { name: _name, description: own, ...others } = extra;
  const description =
    typeof own === "string" && own.trim()
      ? own.trim()
      : meta.description.replace(/\s+/g, " ").trim();

  const block = stringify({ name: meta.name, description, ...others }, { lineWidth: 0 });

  return `---\n${block}---\n\n${rest.replace(/^\n+/, "")}`;
}
