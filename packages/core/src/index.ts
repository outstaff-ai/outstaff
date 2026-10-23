export const name = "@outstaff/core";

export { CONFIG_CODES, type ConfigCode } from "./config/codes.js";
export { type ConfigIssue } from "./config/issues.js";
export { teamConfigSchema, adapterRefSchema, type TeamConfig, type TeamConfigInput } from "./config/schema.js";
export { parseTeamConfig, type ParseResult } from "./config/parse.js";
export { buildTeamJsonSchema } from "./config/json-schema.js";
export {
  ADAPTER_PORTS,
  registerAdapterOptions,
  validateAdapterOptions,
  clearAdapterOptions,
  type AdapterPort,
} from "./config/adapters.js";
