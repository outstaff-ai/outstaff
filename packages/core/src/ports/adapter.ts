import type { Capability } from "../types.js";
import type { AdapterPort, ConfigWarning, TeamConfig } from "../config/types.js";
import type { CommandRule, Profile } from "../permissions/types.js";
import type { ZodType } from "zod";
import type { Logger, SecretSource, SecretSpec } from "./types.js";

export type PortName = AdapterPort;

/** The person a secret list is asked for; without it the list is every key the adapter can ever need. */
export interface SecretsContext {
  team: TeamConfig;
  person: TeamConfig["people"][number];
}

export interface AdapterContext<Options> {
  options: Options;
  secrets: SecretSource;

  /** Every secret key declared by the registered adapters, both scopes. Set by the host; adapters that start child processes scrub these from the child's environment. */
  secretKeys?: readonly string[];
  team: TeamConfig;

  /** Which container the port is created for. Absent means "person". */
  scope?: "person" | "office";
  log: Logger;
  fetch: typeof fetch;
  now: () => Date;
}

/** One step of an adapter's setup guide, printed by `ost setup`. */
export interface SetupStep {
  title: string;

  /** Markdown. */
  body: string;

  /** Text to paste into the provider, for example an app manifest. */
  manifest?: string;
}

export interface SetupContext {
  team: TeamConfig;

  /** The person being set up; absent for the office. */
  person?: TeamConfig["people"][number];

  /** The permission profile of the person's role, when the host resolved it. Only a profile that honours write grants lets a write grant count. */
  profile?: Profile;

  /** Capabilities the person's role needs or uses (`needs` and `optional_needs`), when the host resolved the role. */
  roleCapabilities?: Capability[];
  scope: "person" | "office";

  /** The options of this adapter's integration in the team file. */
  options: unknown;
}

export interface DeriveContext extends SetupContext {
  fetch: typeof fetch;
  now: () => Date;

  /** Reports something the person should know, for example that an App is not installed yet. Never put secrets in it. */
  warn: (message: string) => void;
}

/** One finding of `ost doctor`. */
export interface DoctorCheck {
  /** The secret key the check is about, when it is about one. */
  key?: string;
  name: string;
  status: "ok" | "warn" | "fail";

  /** Names exactly which value is wrong. Never contains a secret value. */
  detail: string;

  /** What to change, when `status` is not `ok`. */
  fix?: string;
}

export interface AdapterDefinition<P extends PortName, Options, Impl> {
  port: P;

  /** For example "itsaplan", "github", "slack", "claude-agent-sdk". */
  name: string;
  capabilities: Capability[];
  options: ZodType<Options>;

  /**
   * The keys the adapter reads. For a person, `ctx` narrows the list to what that person needs (a person without
   * repository grants needs no GitHub keys); without it, every key either scope can use, which is what secret
   * scrubbing and the container-contract table want.
   */
  secrets: (scope: "person" | "office", ctx?: SecretsContext) => SecretSpec[];
  create(ctx: AdapterContext<Options>): Impl | Promise<Impl>;

  /**
   * A person-scope adapter the person has no use for returns why here, in words an agent can pass on; the agent
   * then starts without that port and the verbs that need it refuse with this message.
   */
  unavailableFor?: (ctx: SecretsContext) => string | undefined;

  /** Step-by-step instructions for `ost setup`. Never include secret values. */
  setupGuide?: (ctx: SetupContext) => SetupStep[];

  /**
   * Looks up the values the person's primary secrets make available (the `derivable` keys of `secrets`). Returns only
   * keys it could compute; `ost setup --derive` writes them as secret files and never prints them.
   */
  derive?: (secrets: SecretSource, ctx: DeriveContext) => Promise<Record<string, string>>;

  /**
   * Live checks for `ost doctor`: calls the provider with the person's (or the office's) secrets and compares the
   * answers with the team file. Skip what needs a secret that is missing, since doctor reports that itself. Never put a
   * secret value in a check.
   */
  doctor?: (secrets: SecretSource, ctx: DeriveContext) => Promise<DoctorCheck[]>;

  /**
   * Command rules for the adapter's own CLI, for example a read-only `pr view` allow and a mutating `api` deny.
   * Merged into agents' policies as an `adapter` rule pack; deny wins over allow whatever the source.
   */
  /**
   * Runtime adapters only: where the runtime expects the rendered working files (skills, references, templates,
   * process documents), as a map from rendered path to path below the working directory. Without it they stay as rendered.
   */
  workdirLayout?: (files: ReadonlyMap<string, string>) => Map<string, string>;

  /**
   * Checks the identities this adapter's platform owns (`humans[].identities.*`, `people[].identities.*`) and returns
   * located warnings with stable codes, for example at `humans.0.identities.chat`. Called by `ost validate`.
   */
  validateIdentities?: (team: TeamConfig) => ConfigWarning[];

  permissions?: (scope: "person" | "office") => CommandRule[];
}
