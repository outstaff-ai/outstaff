export const name = "@outstaff/core";

export { CONFIG_CODES, type ConfigCode } from "./config/codes.js";
export { type ConfigIssue } from "./config/issues.js";
export {
  teamConfigSchema,
  adapterRefSchema,
  type TeamConfig,
  type TeamConfigInput,
} from "./config/schema.js";

export { parseTeamConfig, type ParseResult } from "./config/parse.js";
export { buildTeamJsonSchema } from "./config/json-schema.js";
export {
  ADAPTER_PORTS,
  registerAdapterOptions,
  validateAdapterOptions,
  clearAdapterOptions,
  type AdapterPort,
} from "./config/adapters.js";

export {
  loadTeamConfig,
  formatIssue,
  type LoadOptions,
  type LoadResult,
  type LocatedIssue,
  type ConfigSource,
} from "./config/load.js";

export { type ConfigFs, type GitClient } from "./config/io.js";
export { CAPABILITIES, CAPABILITY_PORT, type Capability } from "./capabilities.js";
export {
  validateTeam,
  documentedCodes,
  WARNING_CODES,
  type WarningCode,
  type RoleNeeds,
  type AdapterInfo,
  type IdentityValidator,
  type ValidationContext,
  type ValidationReport,
  type ConfigWarning,
} from "./config/validate.js";

export {
  identitiesOf,
  identityWarning,
  vcsAgentLogins,
  type IdentityRef,
} from "./config/identities.js";

export { parseYaml, type ParsedYaml, type Position } from "./config/locate.js";

export * from "./catalog/index.js";
export * from "./render/index.js";

export * from "./permissions/index.js";
export * from "./ports/index.js";
export * from "./workflow/index.js";
export * from "./policies/index.js";
