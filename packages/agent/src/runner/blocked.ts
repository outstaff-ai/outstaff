import type { Tracker } from "@outstaff/core";

/** Whether one of the tickets is blocked in the tracker now. A ticket the tracker cannot read counts as not blocked. */
export async function anyBlocked(
  tracker: Tracker | undefined,
  tickets: string[],
): Promise<boolean> {
  if (!tracker) {
    return false;
  }

  for (const key of tickets) {
    try {
      if ((await tracker.getIssue(key)).status.canonical === "blocked") {
        return true;
      }
    } catch {
      // Unreadable: it does not make the hand-back blocked.
    }
  }

  return false;
}
