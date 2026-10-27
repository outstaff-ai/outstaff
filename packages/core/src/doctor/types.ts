import type { TeamConfig } from "#/config/types.js";
import type { AdapterDefinition, DeriveContext, DoctorCheck } from "#/ports/adapter.js";
import type { SecretSource, SecretSpec } from "#/ports/types.js";

export type DoctorScope = "person" | "office";

// Definitions with different option types live in one list.
// oxlint-disable-next-line no-explicit-any
export type AnyAdapterDefinition = AdapterDefinition<any, any, any>;

/** An adapter the team file configures, with its options from the team file. */
export interface ConfiguredAdapter {
  def: AnyAdapterDefinition;
  options: unknown;
}

/** The secrets one adapter (or the framework itself) reads, under a title. */
export interface SecretSection {
  title: string;
  specs: SecretSpec[];
}

/** A check with the adapter that made it, when an adapter did. */
export type ScopedCheck = DoctorCheck & { adapter?: string };

/** Everything the shared doctor checks of one scope (the office, or one person) need. */
export interface ScopeChecksInput {
  team: TeamConfig;
  scope: DoctorScope;
  person?: TeamConfig["people"][number];

  /** The adapters the team configures for this scope, and the ones this build does not ship. */
  adapters: { found: ConfiguredAdapter[]; unknown: string[] };
  secrets: SecretSource;

  /** The secrets directory the secrets are read from, for the file mode checks and the fixes. */
  dir: string;

  /**
   * Whether to check that secret files are private (default true). False where the platform mounts them, which sets
   * their mode (for example 0440 with a group, in the Kubernetes guide).
   */
  fileModes?: boolean;

  /** The handle the fixes name (`ost setup <handle>`): a person's handle or `office`. */
  handle: string;

  /** What the adapters' checks get beyond the team, scope, person and options. */
  context: Pick<DeriveContext, "fetch" | "now"> &
    Partial<Pick<DeriveContext, "profile" | "roleCapabilities">>;

  /** Checks of the host (office reachability, tools, network) to report after the secrets, before the adapters'. */
  extra?: DoctorCheck[];
}

/** A repo of the team file. */
export type RepoEntry = TeamConfig["repos"][number];

/** What a repo's merge gate leaves open: the risk to agents' pull requests and the fix. */
export interface MergeGateGap {
  risk: string;
  fix: string;
}
