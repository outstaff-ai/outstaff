import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  formatCatalogIssue,
  loadCatalog,
  loadToolset,
  CatalogError,
  type Catalog,
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

/** The toolsets of a role and the roles it extends, in the order they apply, from the stock catalog's `toolsets/`. */
export function loadToolsets(
  stockCatalogDir: string,
  roles: Record<string, { toolset?: string | undefined } | undefined>,
  role: string,
  extended: string[],
): Toolset[] {
  const names = [...new Set([role, ...extended].map((r) => roles[r]?.toolset).filter((t) => t))];
  const toolsets: Toolset[] = [];
  for (const name of names as string[]) {
    const file = join(stockCatalogDir, "toolsets", `${name}.yaml`);
    if (existsSync(file)) {
      toolsets.push(loadToolset(file));
    }
  }

  return toolsets;
}
