export type MoveTarget = { before: string } | { after: string } | { last: true };

export interface QueuePlacement {
  id: string;
  priority: number;
  position: number;
}

export interface LoopGuardVerdict {
  tripped: boolean;
  reason?: string;
}

export interface UsageWindow {
  /** For example "5h" or "7d". */
  name: string;

  /** Fraction of the limit used, 0..1. */
  utilization: number;
}

export interface UsageThresholds {
  defer_scheduled_at: number;
  pause_automatic_at: number;
}

export type RunBlockCode = "paused_team" | "paused_person" | "usage_defer" | "usage_pause";

export interface RunBlock {
  code: RunBlockCode;
  reason: string;
}

export type StaleVerdict = "ok" | "retry" | "block";

export interface RetryPolicy {
  base_minutes: number;
  cap_minutes: number;
  max_failures: number;
}
