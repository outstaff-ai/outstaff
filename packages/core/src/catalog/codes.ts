import type { CatalogIssue } from "./types.js";

/** Stable machine-readable codes for catalog problems. Never rename; add new ones. */
export const CATALOG_CODES = {
  notFound: "catalog.not_found",
  readFailed: "catalog.read_failed",
  versionMissing: "catalog.version_missing",
  yamlSyntax: "catalog.yaml_syntax",
  roleInvalid: "catalog.role_invalid",
  missingFile: "catalog.missing_file",
  nameMismatch: "catalog.name_mismatch",
  unknownExtends: "catalog.unknown_extends",
  unknownRole: "catalog.unknown_role",
  extendsCycle: "catalog.extends_cycle",
  unknownPlaceholder: "catalog.unknown_placeholder",
  invalidTag: "catalog.invalid_tag",
  unclosedTag: "catalog.unclosed_tag",
  unbalancedBlock: "catalog.unbalanced_block",
  notScalar: "catalog.not_scalar",
  notIterable: "catalog.not_iterable",
  frontMatterInvalid: "catalog.front_matter_invalid",
} as const;

export function formatCatalogIssue(issue: CatalogIssue): string {
  return `${issue.file}:${issue.line}:${issue.column} ${issue.code}: ${issue.message}`;
}

export class CatalogError extends Error {
  readonly issues: CatalogIssue[];
  constructor(issues: CatalogIssue[]) {
    super(issues.map(formatCatalogIssue).join("\n"));
    this.name = "CatalogError";
    this.issues = issues;
  }
}
