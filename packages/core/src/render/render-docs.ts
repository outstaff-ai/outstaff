import { CatalogError } from "../catalog/codes.js";
import { render } from "../catalog/template.js";
import type { CatalogDoc, CatalogIssue, CatalogRole } from "../catalog/types.js";
import { withSkillFrontMatter } from "./frontmatter.js";
import type { DocRendering } from "./types.js";

const DOC_PATH = /(?<![\w/.-])(?:process|references|templates)\/[\w.-]+\.md\b/g;

const absolutize = (text: string, workdir: string | undefined): string =>
  workdir ? text.replace(DOC_PATH, (p) => `${workdir.replace(/\/+$/, "")}/${p}`) : text;

/** LF line endings and exactly one trailing newline. */
const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");

/** A document rendered to `path`, or the issues rendering it raised; rendered once per path and shared. */
export function renderCached(
  r: DocRendering,
  path: string,
  doc: CatalogDoc,
  skillOf?: CatalogRole,
): string | CatalogIssue[] {
  let hit = r.cache.get(path);
  if (hit === undefined) {
    hit = renderDoc(r, doc, skillOf);
    r.cache.set(path, hit);
  }

  return hit;
}

/** A role's skill gets the front matter that makes the runtime list it as a skill. */
function renderDoc(
  r: DocRendering,
  doc: CatalogDoc,
  skillOf?: CatalogRole,
): string | CatalogIssue[] {
  try {
    const text = absolutize(normalize(render(doc.text, r.context, { file: doc.file })), r.workdir);
    return skillOf
      ? withSkillFrontMatter(text, { name: skillOf.name, description: skillOf.summary }, doc.file)
      : text;
  } catch (e) {
    if (!(e instanceof CatalogError)) {
      throw e;
    }

    return e.issues;
  }
}
