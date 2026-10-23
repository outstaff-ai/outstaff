export {
  CATALOG_CODES,
  CatalogError,
  formatCatalogIssue,
  type CatalogCode,
  type CatalogIssue,
} from "./codes.js";

export { roleSchema, type Role } from "./role.js";
export {
  loadCatalog,
  type Catalog,
  type CatalogDoc,
  type CatalogRole,
  type LoadCatalogOptions,
} from "./load.js";

export { parseTemplate, render, type RenderOptions, type Template } from "./template.js";
export {
  buildPersonContext,
  buildTeamContext,
  PORTS,
  type CatalogContext,
  type ContextExtras,
  type PersonContext,
  type RepoContext,
  type TeamContext,
} from "./context.js";
