export type CanonicalStatus =
  | "backlog"
  | "ready"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "canceled";

export const CANONICAL_STATUSES: readonly CanonicalStatus[] = [
  "backlog",
  "ready",
  "active",
  "review",
  "blocked",
  "done",
  "canceled",
];

/** Canonical status -> the status name used in the tracker (from `team.workflow.statuses`). */
export type StatusMap = Partial<Record<CanonicalStatus, string>>;
