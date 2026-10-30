import type { MergeRequirements, StaticWorkflowData } from "@outstaff/core";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { Policy } from "#/pipeline/policy.types.js";
import type { PipelineOptions, ReadyTicket } from "#/pipeline/state.types.js";

/** The world after an event: the office's static state plus the agents' ready tickets. */
export interface ReplayWorld extends StaticWorkflowData {
  ready?: Record<string, ReadyTicket[]>;
}

/** A merge step also re-checks every other open pull request of the repository, as the work state does. */
export interface ReplayMerge {
  /** Mergeability of the other pull requests before and after the merge, by number; clean when not listed. */
  before?: Record<number, "clean" | "conflicting">;
  after?: Record<number, "clean" | "conflicting">;

  /** What the code host requires of the default branch, as the vcs port reads it; nothing when not given. */
  requirements?: MergeRequirements;
}

/** One event and the world after it. */
export interface ReplayStep {
  event: PipelineEvent;
  world: ReplayWorld;
  merge?: ReplayMerge;
}

export interface ReplayScenario {
  title: string;
  steps: ReplayStep[];
}

/** What the pipeline runs with. */
export interface ReplaySetup {
  policies: readonly Policy[];
  pipelineOptions: PipelineOptions;
  coalesceMs: number;
}

export interface ReplayRow {
  event: PipelineEvent;

  /** Raised by the merge re-check, not by a source. */
  derived: boolean;

  /** What the pipeline decided, for people: the wakes, the tracker changes and the drops. */
  decisions: string[];
}

export interface ReplayResult {
  scenarios: { title: string; rows: ReplayRow[] }[];

  /** Every wake the pipeline decided, folded as the scheduler would. */
  coalesced: { person: string; subject: string; kind: string; events: string[] }[];
}
