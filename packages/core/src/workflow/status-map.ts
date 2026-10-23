import { CANONICAL_STATUSES, type CanonicalStatus, type StatusMap } from "../ports/status.js";

export interface WorkflowStatusMap {
  /** The tracker's name for a canonical status. */
  toTracker(status: CanonicalStatus): string;

  /** Canonical status for a tracker name (case-insensitive), or undefined if unmapped. */
  toCanonical(name: string): CanonicalStatus | undefined;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Defaults to the Title Case canonical names (Backlog, Ready, Active, ...). */
export function createStatusMap(configured: StatusMap = {}): WorkflowStatusMap {
  const names = {} as Record<CanonicalStatus, string>;
  for (const s of CANONICAL_STATUSES) {
    names[s] = configured[s] ?? titleCase(s);
  }

  const reverse = new Map<string, CanonicalStatus>();
  for (const s of CANONICAL_STATUSES) {
    const key = names[s].trim().toLowerCase();
    if (!reverse.has(key)) {
      reverse.set(key, s);
    }
  }

  return {
    toTracker: (s) => names[s],
    toCanonical: (name) => reverse.get(name.trim().toLowerCase()),
  };
}
