import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatCatalogIssue,
  loadCatalog,
  loadToolset,
  CatalogError,
  type Catalog,
  type Profile,
  type TeamConfig,
  type Toolset,
} from "@outstaff/core";
import { StartupError } from "./startup-error.js";

export function loadCatalogs(
  stockDir: string,
  team: TeamConfig,
  teamDir: string,
): { stock: Catalog; ejected?: Catalog } {
  try {
    const stock = loadCatalog(stockDir);
    const dir = resolve(teamDir, team.catalog.path);
    const ejected =
      existsSync(dir) && statSync(dir).isDirectory()
        ? loadCatalog(dir, { version: team.catalog.version })
        : undefined;

    return { stock, ...(ejected ? { ejected } : {}) };
  } catch (e) {
    if (e instanceof CatalogError) {
      throw new StartupError(
        `The catalog cannot be loaded:\n${e.issues.map(formatCatalogIssue).join("\n")}`,
      );
    }

    throw e;
  }
}

/**
 * The toolsets an agent with this permission profile gets: every `toolsets/*.yaml` whose `profiles` include it (or
 * that names no profiles), from the stock catalog and then the ejected one, where a file replaces the stock file of
 * the same name. Sorted by name.
 */
export function loadToolsets(catalogDirs: (string | undefined)[], profile: Profile): Toolset[] {
  const toolsets: Toolset[] = [];
  for (const [name, file] of toolsetFiles(catalogDirs)) {
    const ts = loadToolset(file);
    if (ts.name !== name) {
      throw new StartupError(
        `Toolset ${file} is named "${ts.name}"; name it "${name}" after its file.`,
      );
    }

    if (!ts.profiles || ts.profiles.includes(profile)) {
      toolsets.push(ts);
    }
  }

  return toolsets;
}

const YAML = /\.ya?ml$/;

/** The toolset files of the catalogs by name, sorted; a later catalog's file replaces an earlier one's. */
function toolsetFiles(catalogDirs: (string | undefined)[]): [string, string][] {
  const files = new Map<string, string>();
  for (const base of catalogDirs.flatMap((d) => (d ? [join(d, "toolsets")] : []))) {
    for (const f of existsSync(base) ? readdirSync(base).filter((n) => YAML.test(n)) : []) {
      files.set(f.replace(YAML, ""), join(base, f));
    }
  }

  return [...files].toSorted(([a], [b]) => a.localeCompare(b));
}
