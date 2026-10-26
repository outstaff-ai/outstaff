import type { Tracker } from "@outstaff/core";

/**
 * Whether a final message says the work is blocked, as a state and not as history: "still blocked", "remains
 * blocked", "blocked on/by/until/waiting", or a message that starts with "Blocked". "No longer blocked" and "was
 * blocked" do not count.
 */
export function saysBlocked(text: string): boolean {
  const t = text.trim();
  if (/\b(?:no longer|not|un|was|were|got|been)\s*-?\s*blocked\b/i.test(t)) {
    return false;
  }

  return (
    /^\W*blocked\b/i.test(t) ||
    /\b(?:still|remains?|remaining|currently|am|are|is|stays?)\s+blocked\b/i.test(t) ||
    /\bblocked\s+(?:on|by|until|waiting|pending)\b/i.test(t)
  );
}

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
      // Unreadable: the message alone does not make it blocked.
    }
  }

  return false;
}
