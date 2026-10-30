import type { z } from "zod";
import type { Capability } from "#/types.js";
import type { ADAPTER_PORTS } from "./adapters.js";
import type { CONFIG_CODES } from "./codes.js";
import type { networkSchema } from "./network.js";
import type { teamConfigSchema } from "./schema.js";
import type { WARNING_CODES } from "./warning-codes.js";

export type TeamConfig = z.output<typeof teamConfigSchema>;
export type TeamConfigInput = z.input<typeof teamConfigSchema>;

export type AdapterPort = (typeof ADAPTER_PORTS)[number];

export type ConfigCode = (typeof CONFIG_CODES)[keyof typeof CONFIG_CODES];

/**
 * Keys that are gone, by the parent key and the key, with what to do instead. They fail validation like any unknown
 * key, with this message.
 */
export type RemovedKeys = Record<string, string>;

export type ConfigIssue = {
  path: (string | number)[];
  code: string;
  message: string;
};

export interface ConfigFs {
  readFile(path: string): Promise<string>;

  /** Returns null when the path does not exist. */
  kind(path: string): Promise<"file" | "dir" | null>;
}

export interface GitClient {
  /** Make `dir` a checkout of `url` at `ref` (the default branch when omitted), shallow. */
  sync(args: { url: string; ref?: string; dir: string }): Promise<void>;
}

export type Position = { line: number; column: number };
export type LocatedIssue = ConfigIssue & { file: string; line: number; column: number };

export type ParsedYaml = {
  value: unknown;
  syntaxErrors: { message: string; position: Position }[];
  locate: (issue: ConfigIssue) => Position;
};

export type Network = z.output<typeof networkSchema>;
export type HttpGrant = NonNullable<Network["http"]>[number];

/** What a person may reach after role and person grants are merged. */
export interface NetworkGrants {
  http: HttpGrant[];
}

export type ParseResult = { ok: true; config: TeamConfig } | { ok: false; issues: ConfigIssue[] };

export type ConfigSource = {
  kind: "file" | "git";

  /** Absolute path of the team file. */
  file: string;

  /** Directory containing the team file; `catalog.path` is relative to it. */
  dir: string;
  repo?: string;
  ref?: string;
};

export type LoadOptions = {
  /** Path to a file or directory, or a git URL with an optional `#ref`. */
  team?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  fs?: ConfigFs;
  git?: GitClient;
};

export type LoadResult =
  | { ok: true; config: TeamConfig; source: ConfigSource }
  | { ok: false; issues: LocatedIssue[]; source?: ConfigSource };

export type IdentityRef = { path: (string | number)[]; subject: string; value: string };

export type RoleNeeds = { needs: Capability[]; optionalNeeds?: Capability[] };
export type AdapterInfo = { port: AdapterPort; name: string; capabilities: Capability[] };

/** An adapter's check of the identities it owns (see `AdapterDefinition.validateIdentities`). */
export type IdentityValidator = (team: TeamConfig) => ConfigWarning[];

export type ValidationContext = {
  /** Catalog roles by name. An empty map means the catalog is unknown and role names are not checked. */
  roles: Map<string, RoleNeeds>;

  /** Installed adapters keyed by `<port>/<adapter>`. An empty map means adapter names are not checked. */
  adapters: Map<string, AdapterInfo>;

  /** Identity checks of installed adapters keyed `<port>/<adapter>`; only those of configured integrations run. Independent of `adapters`, so a host can check identities without checking adapter names. */
  identityValidators?: Map<string, IdentityValidator>;

  /** Capabilities of installed adapters keyed `<port>/<adapter>`, for the `policies` switch checks. Defaults to `adapters`; independent of it, so a host can check switches without checking adapter names. */
  adapterCapabilities?: Map<string, AdapterInfo>;

  /** Secret keys the framework and the installed adapters read. A network token may not name one of them. */
  secretKeys?: ReadonlySet<string>;
};

export type ConfigWarning = ConfigIssue & {
  /** One sentence on what will not work. */
  consequence: string;
};

export type ValidationReport = { errors: ConfigIssue[]; warnings: ConfigWarning[] };

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];
