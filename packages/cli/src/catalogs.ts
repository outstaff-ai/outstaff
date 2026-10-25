import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CatalogError,
  loadCatalog,
  type Capability,
  type Catalog,
  type CatalogIssue,
  type LocatedIssue,
  type Profile,
  type RoleNeeds,
  type TeamConfig,
} from "@outstaff/core";
import type { Context } from "./define.js";

export type TeamCatalogs = { stock: Catalog; ejected?: Catalog };
export type CatalogsResult =
  | { ok: true; catalogs: TeamCatalogs }
  | { ok: false; issues: CatalogIssue[] };

/** Root of the installed `@outstaff/catalog` package. */
export const stockCatalogDir = (ctx: Context): string =>
  ctx.stockCatalogDir ??
  dirname(fileURLToPath(import.meta.resolve("@outstaff/catalog/package.json")));

/**
 * Loads the stock catalog from the installed package and, when it exists, the
 * client's ejected one from `catalog.path` next to the team file.
 */
export function loadCatalogs(ctx: Context, config: TeamConfig, teamDir: string): CatalogsResult {
  try {
    const stock = loadCatalog(stockCatalogDir(ctx));
    const dir = resolve(teamDir, config.catalog.path);
    const ejected =
      existsSync(dir) && statSync(dir).isDirectory()
        ? loadCatalog(dir, { version: config.catalog.version })
        : undefined;

    return { ok: true, catalogs: { stock, ...(ejected ? { ejected } : {}) } };
  } catch (e) {
    if (e instanceof CatalogError) {
      return { ok: false, issues: e.issues };
    }

    throw e;
  }
}

/** Roles of the merged catalog for `validateTeam`; a client role replaces a stock one of the same name. */
export function roleRegistry({ stock, ejected }: TeamCatalogs): Map<string, RoleNeeds> {
  const roles = new Map<string, RoleNeeds>();
  for (const role of Object.values({ ...stock.roles, ...ejected?.roles })) {
    roles.set(role.name, {
      needs: role.needs as Capability[],
      ...(role.optional_needs ? { optionalNeeds: role.optional_needs as Capability[] } : {}),
    });
  }

  return roles;
}

/**
 * The permission profile and the capabilities (`needs` and `optional_needs`) of a role in the merged catalog; a
 * client role replaces a stock one of the same name. Empty when the role is unknown.
 */
export const roleProfile = (
  catalogs: TeamCatalogs | undefined,
  role: string,
): { profile: Profile; roleCapabilities: Capability[] } | Record<string, never> => {
  const found = catalogs && { ...catalogs.stock.roles, ...catalogs.ejected?.roles }[role];
  return found
    ? {
        profile: found.permissions,
        roleCapabilities: [...found.needs, ...found.optional_needs] as Capability[],
      }
    : {};
};

export const catalogIssue = (i: CatalogIssue): LocatedIssue => ({
  path: [],
  code: i.code,
  message: i.message,
  file: i.file,
  line: i.line,
  column: i.column,
});
