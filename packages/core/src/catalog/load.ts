import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_CODES, CatalogError } from "./codes.js";
import { loadRoles } from "./load-roles.js";
import { Loading } from "./loading.js";
import type { Catalog, CatalogDoc, LoadCatalogOptions } from "./types.js";

/**
 * Loads a catalog directory: `roles/<role>/{role.yaml,SKILL.md}`,
 * `process/*.md`, `references/*.md`, `templates/*.md`. Every folder is optional,
 * so an ejected catalog may hold only some of them. `profiles/` is reserved
 * and ignored. Throws CatalogError listing every problem with file:line:column.
 */
export function loadCatalog(dir: string, options: LoadCatalogOptions = {}): Catalog {
  const l = new Loading();
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    l.add(CATALOG_CODES.notFound, "Not a catalog: the directory does not exist.", dir);
    throw new CatalogError(l.issues);
  }

  const version = catalogVersion(l, dir, options.version);
  const roles = loadRoles(l, dir);
  const processDocs = docsIn(l, dir, "process");
  const references = docsIn(l, dir, "references");
  const templates = docsIn(l, dir, "templates");

  if (l.issues.length || version === undefined) {
    throw new CatalogError(l.issues);
  }

  return { version, dir, roles, process: processDocs, references, templates };
}

/** The version option, else the version in the catalog's package.json. */
function catalogVersion(l: Loading, dir: string, given: string | undefined): string | undefined {
  if (given !== undefined) {
    return given;
  }

  const pkg = join(dir, "package.json");
  const version = packageVersion(existsSync(pkg) ? l.read(pkg) : undefined);
  if (version === undefined) {
    l.add(
      CATALOG_CODES.versionMissing,
      'No "version" in package.json; pass the version option.',
      pkg,
    );
  }

  return version;
}

/** The non-empty version string of a package.json, if it has one; malformed JSON has none. */
function packageVersion(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

function docsIn(
  l: Loading,
  dir: string,
  kind: "process" | "references" | "templates",
): Record<string, CatalogDoc> {
  const out: Record<string, CatalogDoc> = {};
  const base = join(dir, kind);
  if (!existsSync(base)) {
    return out;
  }

  for (const f of readdirSync(base)
    .filter((n) => n.endsWith(".md"))
    .toSorted()) {
    const d = l.doc(f.slice(0, -3), join(base, f));
    if (d) {
      out[d.name] = d;
    }
  }

  return out;
}
