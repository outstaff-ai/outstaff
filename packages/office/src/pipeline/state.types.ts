import type { ConfiguredPolicy, PolicyOptions, PolicyState } from "@outstaff/policy";

/** The world a policy is judged against: the office's work state as conditions read it, plus the ready tickets. */
export type PipelineState = PolicyState;

export interface PipelineOptions extends PolicyOptions {
  /**
   * How long a wake waits for related ones to join its run (`pipeline.wake.coalesce_seconds`), in milliseconds.
   * Default 60 seconds. Chat wakes and idle pulls never wait.
   */
  coalesceMs?: number | undefined;
}

export interface ConfiguredPipeline {
  /** The built-in policies, then the team's custom ones, with the team's changes. */
  policies: ConfiguredPolicy[];
  options: PipelineOptions;

  /** What in `pipeline.policies` and `policies.custom` was ignored, and why. */
  issues: string[];
}
