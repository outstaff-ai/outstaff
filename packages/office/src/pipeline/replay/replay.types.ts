import type { Rule, StaticWorkflowData, WorkflowOptions } from "@outstaff/core";
import type { Outcome } from "#/pipeline/compare/compare.types.js";
import type { PipelineEvent } from "#/pipeline/events.types.js";
import type { Policy } from "#/pipeline/policy.types.js";
import type { PipelineOptions, ReadyTicket } from "#/pipeline/state.types.js";

/** The world after an event: the workflow rules' static state plus the agents' ready tickets. */
export interface ReplayWorld extends StaticWorkflowData {
  ready?: Record<string, ReadyTicket[]>;
}

/** A merge step also re-checks every other open pull request of the repository, as the work state does. */
export interface ReplayMerge {
  /** Mergeability of the other pull requests before and after the merge, by number; clean when not listed. */
  before?: Record<number, "clean" | "conflicting">;
  after?: Record<number, "clean" | "conflicting">;
  requiresUpToDate?: boolean;

  /** Why a derived event is decided differently, by its id. */
  notes?: Record<string, string>;
}

/**
 * One event and the world after it. `note` explains why today's engine and the pipeline decide differently: it starts
 * with "intended fix:" or "regression:", and is required exactly when they do.
 */
export interface ReplayStep {
  event: PipelineEvent;
  world: ReplayWorld;
  note?: string;
  merge?: ReplayMerge;
}

export interface ReplayScenario {
  title: string;
  steps: ReplayStep[];
}

/** What both sides run with. */
export interface ReplaySetup {
  rules: readonly Rule[];
  workflowOptions: WorkflowOptions;
  policies: readonly Policy[];
  pipelineOptions: PipelineOptions;

  /** The team's agents, for the engine's check that a schedule names one. */
  people: readonly string[];
  coalesceMs: number;
}

export interface ReplayRow {
  event: PipelineEvent;

  /** Raised by the merge re-check, not by a source. */
  derived: boolean;
  today: string[];
  pipeline: string[];
  same: boolean;
  note?: string | undefined;
}

export interface ReplayResult {
  scenarios: { title: string; rows: ReplayRow[] }[];

  /** Every wake the pipeline decided, folded as the scheduler would. */
  coalesced: { person: string; subject: string; kind: string; events: string[] }[];

  /** Notes missing for a difference, or present without one; empty when the fixture is consistent. */
  problems: string[];
}

/** A merge-derived event, and which side raises it. */
export interface Derived {
  event: PipelineEvent;
  today: boolean;
  pipeline: boolean;
}

export interface Side {
  /** What it does, for people: identity and detail. */
  shown: string[];

  /** What is compared: the wakes and tracker changes. */
  outcomes: Outcome[];
}
