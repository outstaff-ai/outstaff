export const name = "@outstaff/core";

export { CONFIG_CODES } from "./config/codes.js";
export { teamConfigSchema } from "./config/schema.js";
export { adapterRefSchema } from "./config/integrations-schema.js";
export { compileTicketLink, TICKET_KEY } from "./config/ticket-link.js";
export { grantTokenKeys, networkGrants, networkSchema, originOf } from "./config/network.js";
export { parseTeamConfig } from "./config/parse.js";
export { buildTeamJsonSchema } from "./config/json-schema.js";
export {
  ADAPTER_PORTS,
  registerAdapterOptions,
  validateAdapterOptions,
  clearAdapterOptions,
} from "./config/adapters.js";

export { loadTeamConfig, formatIssue } from "./config/load.js";
export { CAPABILITIES, CAPABILITY_PORT } from "./capabilities.js";
export type { Capability } from "./types.js";
export { validateTeam } from "./config/validate.js";
export { documentedCodes } from "./config/documented-codes.js";
export { WARNING_CODES } from "./config/warning-codes.js";
export { identitiesOf, identityWarning, vcsAgentLogins } from "./config/identities.js";
export { parseYaml } from "./config/locate.js";
export type {
  AdapterInfo,
  AdapterPort,
  AdbGrant,
  ConfigCode,
  ConfigFs,
  ConfigIssue,
  ConfigSource,
  ConfigWarning,
  GitClient,
  HttpGrant,
  IdentityRef,
  IdentityValidator,
  LoadOptions,
  LoadResult,
  LocatedIssue,
  Network,
  NetworkGrants,
  ParsedYaml,
  ParseResult,
  Position,
  RoleNeeds,
  TeamConfig,
  TeamConfigInput,
  ValidationContext,
  ValidationReport,
  WarningCode,
} from "./config/types.js";

export * from "./catalog/index.js";
export * from "./render/index.js";

export * from "./permissions/index.js";
export * from "./ports/index.js";
export * from "./workflow/index.js";
export * from "./policies/index.js";
export * from "./links/index.js";
export { mentionData, parseMentions } from "./mentions.js";
