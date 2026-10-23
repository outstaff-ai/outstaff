import type { Capability } from "../capabilities.js";
import { CAPABILITY_PORT } from "../capabilities.js";
import { CATALOG_CODES, CatalogError, type CatalogIssue } from "../catalog/codes.js";
import { buildContext } from "../catalog/context.js";
import type { Catalog, CatalogDoc, CatalogRole } from "../catalog/load.js";
import { render } from "../catalog/template.js";
import type { TeamConfig } from "../config/schema.js";

export type RenderWarning = { code: string; message: string };

export type RenderedWorkdir = {
  /** Relative path (forward slashes) to text; keys are sorted. */
  files: Map<string, string>;
  role: string;

  /** Extra roles whose skills were rendered, in render order. */
  extends: string[];

  /** The role's permission profile; the runtime adapter compiles it. */
  profile: CatalogRole["permissions"];
  warnings: RenderWarning[];
};

export type RenderPersonOptions = {
  team: TeamConfig;
  handle: string;
  catalog: Catalog;

  /** Client's `.outstaff/catalog/`; same-named roles and documents replace stock ones. */
  ejected?: Catalog;

  /** URL templates for the `links` placeholders. */
  links?: Record<string, string>;
};

export const RENDER_WARNING_CODES = { missingCapability: "render.missing_capability" } as const;

/** All problems found while rendering, as one error. */
export class RenderError extends CatalogError {
  constructor(issues: CatalogIssue[]) {
    super(issues);
    this.name = "RenderError";
  }
}

const merge = (stock: Catalog, ejected?: Catalog) => ({
  roles: { ...stock.roles, ...ejected?.roles },
  process: { ...stock.process, ...ejected?.process },
  references: { ...stock.references, ...ejected?.references },
  templates: { ...stock.templates, ...ejected?.templates },
});

/** LF line endings and exactly one trailing newline. */
const normalize = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");

/**
 * Renders the working files of one person: skills, agent definition,
 * references, templates and process documents. Throws RenderError listing
 * every problem (file:line:column) instead of stopping at the first.
 */
export function renderPerson(options: RenderPersonOptions): RenderedWorkdir {
  const { team, handle, catalog, ejected, links } = options;
  const merged = merge(catalog, ejected);
  const person = team.people.find((p) => p.handle === handle);
  if (!person) {
    throw new Error(
      `Unknown person "${handle}"; the team has: ${team.people.map((p) => p.handle).join(", ") || "nobody"}.`,
    );
  }

  const issues: CatalogIssue[] = [];
  const fail = (message: string) =>
    issues.push({
      code: CATALOG_CODES.unknownRole,
      message,
      file: "team.yaml",
      line: 1,
      column: 1,
    });

  const role = merged.roles[person.role];
  if (!role) {
    throw new RenderError([
      {
        code: CATALOG_CODES.unknownRole,
        message: `Person "${handle}" has unknown role "${person.role}"; the catalog has: ${Object.keys(merged.roles).toSorted().join(", ") || "none"}.`,
        file: "team.yaml",
        line: 1,
        column: 1,
      },
    ]);
  }

  // Role first, then person-level extends, then role.yaml extends; transitive, deduped.
  const order: string[] = [person.role];
  const queue = [...(person.extends ?? []), ...(role.extends ?? [])];
  while (queue.length) {
    const name = queue.shift()!;
    if (order.includes(name)) {
      continue;
    }

    const found = merged.roles[name];
    if (!found) {
      fail(
        `Person "${handle}" extends unknown role "${name}"; the catalog has: ${Object.keys(merged.roles).toSorted().join(", ")}.`,
      );

      continue;
    }

    order.push(name);
    queue.push(...(found.extends ?? []));
  }

  const context = buildContext(team, handle, {
    ...(links ? { links } : {}),
    roles: Object.keys(merged.roles).toSorted(),
    ...(role.default_model ? { defaultModel: role.default_model } : {}),
  });

  const out = new Map<string, string>();
  const put = (path: string, doc: CatalogDoc) => {
    try {
      out.set(path, normalize(render(doc.text, context, { file: doc.file })));
    } catch (e) {
      if (e instanceof CatalogError) {
        issues.push(...e.issues);
      } else {
        throw e;
      }
    }
  };

  for (const name of order) {
    const r = merged.roles[name];
    if (r) {
      put(`skills/${name}/SKILL.md`, r.skill);
    }
  }

  put(`agents/${person.role}.md`, role.agent);
  for (const kind of ["references", "templates", "process"] as const) {
    for (const [name, doc] of Object.entries(merged[kind])) {
      put(`${kind}/${name}.md`, doc);
    }
  }

  if (issues.length) {
    throw new RenderError(issues);
  }

  const warnings: RenderWarning[] = [];
  const has = context.integrations.has;
  for (const need of role.needs) {
    const port = CAPABILITY_PORT[need as Capability];
    if (!has[port]) {
      warnings.push({
        code: RENDER_WARNING_CODES.missingCapability,
        message: `Role "${person.role}" needs ${need} but the team has no ${port} integration.`,
      });
    }
  }

  const files = new Map([...out].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { files, role: person.role, extends: order.slice(1), profile: role.permissions, warnings };
}
