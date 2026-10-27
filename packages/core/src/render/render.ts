import type { Capability } from "#/types.js";
import { CAPABILITY_PORT } from "#/capabilities.js";
import { CATALOG_CODES, CatalogError } from "#/catalog/codes.js";
import { buildContext } from "#/catalog/context.js";
import type { Catalog, CatalogDoc, CatalogIssue, CatalogRole } from "#/catalog/types.js";
import { renderCached } from "./render-docs.js";
import type {
  DocRendering,
  RenderedWorkdir,
  RenderPersonOptions,
  RenderTeamOptions,
  RenderWarning,
  RoleCache,
} from "./types.js";

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

/**
 * Renders the working files of one person: skills, references, templates and
 * process documents. Every file renders with the same team context (there is
 * no `person`), so a file reads the same for everyone. Throws RenderError
 * listing every problem (file:line:column) instead of stopping at the first.
 */
export function renderPerson(options: RenderPersonOptions): RenderedWorkdir {
  return renderWith(options, new Map());
}

/**
 * Renders every person of the team. Role-level files are rendered once and
 * shared, so people with the same role get byte-identical skills.
 */
export function renderTeam(options: RenderTeamOptions): Map<string, RenderedWorkdir> {
  const cache: RoleCache = new Map();
  const result = new Map<string, RenderedWorkdir>();
  const issues = new Map<string, CatalogIssue>();
  for (const person of options.team.people) {
    try {
      result.set(person.handle, renderWith({ ...options, handle: person.handle }, cache));
    } catch (e) {
      if (!(e instanceof RenderError)) {
        throw e;
      }

      for (const issue of e.issues) {
        issues.set(JSON.stringify(issue), issue);
      }
    }
  }

  if (issues.size) {
    throw new RenderError([...issues.values()]);
  }

  return result;
}

type Merged = ReturnType<typeof merge>;
type Person = RenderPersonOptions["team"]["people"][number];

function renderWith(options: RenderPersonOptions, cache: RoleCache): RenderedWorkdir {
  const { team, handle, links, workdir } = options;
  const merged = merge(options.catalog, options.ejected);
  const { person, role } = personAndRole(team.people, handle, merged.roles);
  const { order, issues } = roleOrder(person, role, merged.roles);
  const context = buildContext(team, {
    ...(links ? { links } : {}),
    roles: Object.values(merged.roles)
      .map((r) => ({ name: r.name, title: r.title, summary: r.summary }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  });

  const rendering: DocRendering = { cache, context, workdir };
  const out = new Map<string, string>();
  for (const [path, doc, skillOf] of docsOf(order, merged)) {
    const hit = renderCached(rendering, path, doc, skillOf);
    if (typeof hit === "string") {
      out.set(path, hit);
    } else {
      issues.push(...hit);
    }
  }

  if (issues.length) {
    throw new RenderError(issues);
  }

  return {
    files: new Map([...out].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    role: person.role,
    extends: order.slice(1),
    profile: role.permissions,
    warnings: missingCapabilities(role, person.role, context.integrations.has),
  };
}

function personAndRole(
  people: Person[],
  handle: string,
  roles: Merged["roles"],
): { person: Person; role: CatalogRole } {
  const person = people.find((p) => p.handle === handle);
  if (!person) {
    throw new Error(
      `Unknown person "${handle}"; the team has: ${people.map((p) => p.handle).join(", ") || "nobody"}.`,
    );
  }

  const role = roles[person.role];
  if (!role) {
    throw new RenderError([
      unknownRole(
        `Person "${handle}" has unknown role "${person.role}"; the catalog has: ${Object.keys(roles).toSorted().join(", ") || "none"}.`,
      ),
    ]);
  }

  return { person, role };
}

const unknownRole = (message: string): CatalogIssue => ({
  code: CATALOG_CODES.unknownRole,
  message,
  file: "team.yaml",
  line: 1,
  column: 1,
});

/** Role first, then person-level extends, then role.yaml extends; transitive, deduped. Unknown roles are issues. */
function roleOrder(
  person: Person,
  role: CatalogRole,
  roles: Merged["roles"],
): { order: string[]; issues: CatalogIssue[] } {
  const order: string[] = [person.role];
  const issues: CatalogIssue[] = [];
  const queue = [...(person.extends ?? []), ...(role.extends ?? [])];
  while (queue.length) {
    const name = queue.shift()!;
    if (order.includes(name)) {
      continue;
    }

    const found = roles[name];
    if (found) {
      order.push(name);
      queue.push(...(found.extends ?? []));
    } else {
      issues.push(
        unknownRole(
          `Person "${person.handle}" extends unknown role "${name}"; the catalog has: ${Object.keys(roles).toSorted().join(", ")}.`,
        ),
      );
    }
  }

  return { order, issues };
}

/** The files a person gets: a skill per role in order, then the references, templates and process documents. */
function docsOf(order: string[], merged: Merged): [string, CatalogDoc, CatalogRole?][] {
  const skills = order.flatMap((name): [string, CatalogDoc, CatalogRole][] => {
    const r = merged.roles[name];
    return r ? [[`skills/${name}/SKILL.md`, r.skill, r]] : [];
  });

  const docs = (["references", "templates", "process"] as const).flatMap((kind) =>
    Object.entries(merged[kind]).map(([name, doc]): [string, CatalogDoc] => [
      `${kind}/${name}.md`,
      doc,
    ]),
  );

  return [...skills, ...docs];
}

function missingCapabilities(
  role: CatalogRole,
  roleName: string,
  has: Record<string, boolean>,
): RenderWarning[] {
  return role.needs
    .map((need) => [need, CAPABILITY_PORT[need as Capability]] as const)
    .filter(([, port]) => !has[port])
    .map(([need, port]) => ({
      code: RENDER_WARNING_CODES.missingCapability,
      message: `Role "${roleName}" needs ${need} but the team has no ${port} integration.`,
    }));
}
