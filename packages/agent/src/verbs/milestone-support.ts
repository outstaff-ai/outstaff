import {
  PortError,
  type Initiative,
  type InitiativeStatus,
  type Issue,
  type Tracker,
} from "@outstaff/core";
import { z } from "zod";
import type { Milestones } from "./milestone.types.js";

export const STATUSES: [InitiativeStatus, ...InitiativeStatus[]] = [
  "planned",
  "active",
  "done",
  "canceled",
];

export const milestoneId = z
  .string()
  .min(1)
  .max(64)
  .describe("Id of the milestone, from ost milestone list.");

/** The tracker's initiatives; a tracker without them keeps each milestone as a parent ticket instead. */
export function requireMilestones(tracker: Tracker): Milestones {
  if (!tracker.initiatives || !tracker.setInitiative) {
    throw new PortError(
      "unsupported",
      "This tracker has no initiatives: keep each milestone as a parent ticket instead, with its tickets as sub-tickets (ost ticket create, ost ticket parent).",
    );
  }

  return tracker as Tracker & Milestones;
}

export const milestoneLine = (m: Initiative) => `- ${m.id} [${m.status}] ${m.title}: ${m.url}`;

export const ticketLine = (i: Issue, url: string) =>
  `- ${i.key} [${i.status.canonical ?? i.status.name}] ${i.title}: ${url}`;

/** The milestone a new ticket goes in, checked before anything is written; none when none is asked for. */
export async function milestoneFor(
  tracker: Tracker,
  id: string | undefined,
): Promise<Initiative | undefined> {
  return id === undefined ? undefined : requireMilestones(tracker).getInitiative(id);
}
