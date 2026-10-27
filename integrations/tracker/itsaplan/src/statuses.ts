import {
  PortError,
  type AdapterContext,
  type CanonicalStatus,
  type StatusMap,
} from "@outstaff/core";
import type { ApiColumn, ApiProject } from "@outstaff/integration.shared.itsaplan";
import type { Statuses } from "./types.js";

/** Default status names, Title Case; `team.workflow.statuses` overrides them. */
export const DEFAULT_NAMES: Record<CanonicalStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  active: "Active",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  canceled: "Canceled",
};

/** Used when the project has no column with the mapped name: the first column of this kind. */
const STATE_FOR: Record<CanonicalStatus, string[]> = {
  backlog: ["backlog", "unstarted"],
  ready: ["unstarted", "backlog"],
  active: ["started"],
  review: ["started"],
  blocked: ["started"],
  done: ["completed"],
  canceled: ["canceled"],
};

const CANONICAL_FOR_STATE: Record<string, CanonicalStatus> = {
  backlog: "backlog",
  unstarted: "ready",
  started: "active",
  completed: "done",
  canceled: "canceled",
};

/** The column for a canonical status: the mapped name, else the first column of the matching kind. */
export function columnFor(
  statusMap: StatusMap,
  setup: ApiProject,
  status: CanonicalStatus,
): ApiColumn {
  const name = (statusMap[status] ?? DEFAULT_NAMES[status]).toLowerCase();
  const byName = setup.columns.find((c) => c.name.toLowerCase() === name);
  if (byName) {
    return byName;
  }

  for (const kind of STATE_FOR[status]) {
    const byKind = setup.columns
      .filter((c) => c.stateType === kind)
      .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

    if (byKind) {
      return byKind;
    }
  }

  throw new PortError(
    "invalid",
    `The project has no column for "${status}" (looked for "${statusMap[status]}").`,
  );
}

export function statusOf(
  statusMap: StatusMap,
  setup: ApiProject,
  columnId: number,
): { name: string; canonical?: CanonicalStatus } {
  const col = setup.columns.find((c) => c.id === columnId);
  if (!col) {
    return { name: String(columnId) };
  }

  const lower = col.name.toLowerCase();
  const named = (Object.keys(statusMap) as CanonicalStatus[]).find(
    (s) => statusMap[s]?.toLowerCase() === lower,
  );

  const canonical = named ?? CANONICAL_FOR_STATE[col.stateType];
  return canonical ? { name: col.name, canonical } : { name: col.name };
}

/** The statuses of a team: the default names with `team.workflow.statuses` over them. */
export function teamStatuses(team: AdapterContext<unknown>["team"]): Statuses {
  const map: StatusMap = { ...DEFAULT_NAMES, ...team?.workflow?.statuses };
  return {
    column: (setup, status) => columnFor(map, setup, status),
    status: (setup, columnId) => statusOf(map, setup, columnId),
  };
}
