import type { TrackerField } from "#/ports/tracker.js";
import type { TeamConfig } from "./types.js";

/** The tracker's custom fields that show a ticket's totals: its tokens and its API-equivalent cost. */
export const USAGE_FIELDS = {
  tokens: { name: "Agent tokens", type: "number" },
  cost: { name: "Agent cost, USD (API-equivalent)", type: "number" },
} as const satisfies Record<string, TrackerField>;

/** The team's `usage` settings with their defaults. */
export function usageSettings(team: Pick<TeamConfig, "usage">): {
  trackCost: boolean;
  trackerFields: boolean;
} {
  const trackCost = team.usage?.track_cost ?? true;
  return { trackCost, trackerFields: trackCost && (team.usage?.tracker_fields ?? true) };
}

/** The custom fields the team wants in its tracker: both usage fields, unless tracking or the fields are off. */
export function wantedTrackerFields(team: Pick<TeamConfig, "usage">): TrackerField[] {
  return usageSettings(team).trackerFields ? [USAGE_FIELDS.tokens, USAGE_FIELDS.cost] : [];
}
