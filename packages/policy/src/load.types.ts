import type { ConfiguredPolicy } from "./policy.types.js";

type Settings = { settings?: Record<string, unknown> | undefined };

/** One entry of `policies.custom` in team.yaml: a module of the team's repository, or an npm package. */
export type CustomPolicyEntry = ({ module: string } | { package: string }) & Settings;

export interface LoadedPolicies {
  /** Each policy loaded, with its entry's settings, in the order of the entries. */
  policies: ConfiguredPolicy[];

  /** Each entry that could not be loaded or is not a policy, by its index in `policies.custom`. */
  issues: { index: number; message: string }[];
}
