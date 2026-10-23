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
  buildContext,
  PORTS,
  type CatalogContext,
  type ContextExtras,
  type HumanContext,
  type RoleInfo,
  type PersonContext,
  type RepoContext,
} from "./context.js";
