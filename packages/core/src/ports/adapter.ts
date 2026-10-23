import type { Capability } from "../capabilities.js";
import type { AdapterPort } from "../config/adapters.js";
import type { TeamConfig } from "../config/schema.js";
import type { CommandRule } from "../permissions/types.js";
import type { ZodType } from "zod";
import type { Logger } from "./logger.js";
import type { SecretSource, SecretSpec } from "./secrets.js";

export type PortName = AdapterPort;

export interface AdapterContext<Options> {
  options: Options;
  secrets: SecretSource;

  /** Every secret key declared by the registered adapters, both scopes. Set by the host; adapters that start child processes scrub these from the child's environment. */
  secretKeys?: readonly string[];
  team: TeamConfig;
  log: Logger;
  fetch: typeof fetch;
  now: () => Date;
}

export interface AdapterDefinition<P extends PortName, Options, Impl> {
  port: P;

  /** For example "itsaplan", "github", "slack", "claude-agent-sdk". */
  name: string;
  capabilities: Capability[];
  options: ZodType<Options>;
  secrets: (scope: "person" | "office") => SecretSpec[];
  create(ctx: AdapterContext<Options>): Impl | Promise<Impl>;

  /**
   * Command rules for the adapter's own CLI, for example a read-only `pr view` allow and a mutating `api` deny.
   * Merged into agents' policies as an `adapter` rule pack; deny wins over allow whatever the source.
   */
  permissions?: (scope: "person" | "office") => CommandRule[];
}
