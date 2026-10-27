import type { ActTarget } from "#/pipeline/decisions.types.js";

/**
 * What one side did about an event, in a shape both sides share: the engine's effects and the pipeline's decisions
 * map onto it. `as` is whom a tracker change is attributed to: `office` for the engine; for the pipeline, the agent the office makes it for.
 */
export type Outcome =
  | {
      type: "wake";
      person: string;
      kind: string;
      subject?: { type: string; ref: string } | undefined;
      policy?: string | undefined;
    }
  | { type: "move"; ticket: string; to: string; as: string; policy?: string | undefined }
  | {
      type: "assign";
      ticket: string;
      to: ActTarget | null;
      as: string;
      policy?: string | undefined;
    }
  | { type: "comment"; on: string; as: string; policy?: string | undefined }
  | { type: "set_parent"; ticket: string; parent: string; as: string; policy?: string | undefined };

/** What the engine did about an event, as it applied it. */
export interface EngineRecord {
  /** What it applied, with the schedules it skipped because that work was already queued or running. */
  effects: Outcome[];

  /** Effects the engine decided but did not apply, and why. */
  skipped?: { outcome: Outcome; note: string }[] | undefined;
  failed?: { outcome: Outcome; note: string }[] | undefined;
}

export type DifferenceKind =
  | "missing_in_pipeline"
  | "extra_in_pipeline"
  | "different"
  | "actor_changed";

export interface Difference {
  kind: DifferenceKind;
  engine?: Outcome | undefined;
  pipeline?: Outcome | undefined;

  /** The pipeline policy behind its side, when it has one. */
  policy?: string | undefined;
  note?: string | undefined;
}

/**
 * How the engine's outcome and the pipeline's compare. They agree when they wake the same people for the same work on
 * the same subject and make the same tracker changes; whom a change is attributed to is noted (`actor_changed`) but is not a
 * different outcome.
 */
export interface Comparison {
  agree: boolean;
  differences: Difference[];
}

/** Comparisons over many events, for `ost explain --compare` and the office link. */
export interface ComparisonSummary {
  since?: string | undefined;
  until?: string | undefined;

  /** Events traced in the range, and those of them with both sides recorded. */
  events: number;
  compared: number;
  agree: number;
  differ: number;
  byKind: Partial<Record<DifferenceKind, number>>;

  /** Differences per pipeline policy; `(none)` for an engine effect no policy matches. */
  byPolicy: Record<string, number>;
  differing: { id: string; type: string; at: string; differences: Difference[] }[];
}
