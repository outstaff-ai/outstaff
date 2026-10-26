import type { CanonicalStatus } from "./types.js";

export const CANONICAL_STATUSES: readonly CanonicalStatus[] = [
  "backlog",
  "ready",
  "active",
  "review",
  "blocked",
  "done",
  "canceled",
];
